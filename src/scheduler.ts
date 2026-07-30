import { DurableObject } from "cloudflare:workers";
import { getContainer } from "@cloudflare/containers";
import {
  DEFAULT_MAX_WORKERS_PER_POOL,
  DEFAULT_POLL_INTERVAL_SECONDS,
  parsePoolsConfig,
  parsePositiveInt,
  poolConfigFingerprint,
} from "./config";
import { CursorApiClient } from "./cursor-api";
import type { Env } from "./env";
import {
  containerNameForBroadcast,
  containerNameForSlot,
  planLaunches,
  REQUEST_RECORD_TTL_MS,
  requestMatchesPool,
} from "./matching";
import type {
  PendingRequest,
  PlannedLaunch,
  PoolConfig,
  SlotState,
} from "./types";

const REQUEST_KEY_PREFIX = "req:";
const SLOT_KEY_PREFIX = "slot:";
const BROADCAST_KEY_PREFIX = "bcast:";
const LAST_TICK_KEY = "last-tick";

interface LastTickSummary {
  atMs: number;
  pendingCount: number;
  launched: { containerName: string; requestId?: string }[];
  error?: string;
}

/**
 * Singleton Durable Object that turns Cursor's pending-request queue into
 * container launches:
 *
 *   1. Poll GET /v0/private-workers/pending-requests with the service-account
 *      API key.
 *   2. Match each pending request against the configured pools (pool label +
 *      optional repo restriction).
 *   3. "Claim" matched requests by waking a container slot that boots
 *      `cursor-agent worker start --pool` with the right pool/repos. The
 *      Cursor backend performs the authoritative claim the moment that worker
 *      connects, and the request drops out of the pending list.
 *
 * Pools are durable rows on the Cursor side, so nothing here needs to stay
 * up: the scheduler runs only on cheap Durable Object alarms and containers
 * stop when their worker process exits (scale to zero).
 */
export class PoolScheduler extends DurableObject<Env> {
  private ticking = false;

  override async alarm(): Promise<void> {
    try {
      await this.tick();
    } finally {
      await this.armAlarm();
    }
  }

  /** Ensure the polling loop is running. Called from cron as a safety net. */
  async ensureRunning(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.armAlarm();
    }
  }

  /** One scheduling pass. Also callable via POST /tick for manual pokes. */
  async tick(): Promise<LastTickSummary> {
    if (this.ticking) {
      const last = await this.ctx.storage.get<LastTickSummary>(LAST_TICK_KEY);
      return last ?? { atMs: Date.now(), pendingCount: 0, launched: [] };
    }
    this.ticking = true;
    const summary: LastTickSummary = {
      atMs: Date.now(),
      pendingCount: 0,
      launched: [],
    };
    try {
      const pools = parsePoolsConfig(this.env.POOLS);
      const client = new CursorApiClient(
        this.env.CURSOR_API_URL ?? "https://api.cursor.com",
        this.env.CURSOR_API_KEY
      );

      await this.broadcastPools(pools);

      const pendingRequests = await client.listPendingRequests();
      summary.pendingCount = pendingRequests.length;

      const launches = await this.planTick(pools, pendingRequests);
      for (const launch of launches) {
        await this.executeLaunch(launch);
        summary.launched.push({
          containerName: launch.containerName,
          requestId: launch.spec.requestId,
        });
      }

      await this.pruneRequestRecords(pendingRequests);
    } catch (error) {
      summary.error = String(error);
      console.error(`scheduler tick failed: ${String(error)}`);
    } finally {
      this.ticking = false;
      await this.ctx.storage.put(LAST_TICK_KEY, summary);
    }
    return summary;
  }

  /** Admin view for GET /status. */
  async getStatus(): Promise<unknown> {
    const pools = parsePoolsConfig(this.env.POOLS);
    const lastTick = await this.ctx.storage.get<LastTickSummary>(LAST_TICK_KEY);
    const slotStatuses: unknown[] = [];
    const defaultMaxWorkers = parsePositiveInt(
      this.env.MAX_WORKERS_PER_POOL,
      DEFAULT_MAX_WORKERS_PER_POOL
    );
    for (const pool of pools) {
      const maxWorkers = pool.maxWorkers ?? defaultMaxWorkers;
      for (let index = 0; index < maxWorkers; index++) {
        const stub = getContainer(
          this.env.POOL_WORKER,
          containerNameForSlot(pool.name, index)
        );
        const status = await stub.slotStatus();
        slotStatuses.push({ pool: pool.name, slot: index, ...status });
      }
    }
    return {
      pools,
      lastTick: lastTick ?? null,
      alarmAtMs: await this.ctx.storage.getAlarm(),
      slots: slotStatuses,
    };
  }

  private async armAlarm(): Promise<void> {
    const pollIntervalMs =
      parsePositiveInt(
        this.env.POLL_INTERVAL_SECONDS,
        DEFAULT_POLL_INTERVAL_SECONDS
      ) * 1000;
    await this.ctx.storage.setAlarm(Date.now() + pollIntervalMs);
  }

  /**
   * Compute launches for this tick: pull slot states for pools that have at
   * least one matching pending request, then hand everything to the pure
   * planner.
   */
  private async planTick(
    pools: PoolConfig[],
    pendingRequests: PendingRequest[]
  ): Promise<PlannedLaunch[]> {
    const nowMs = Date.now();
    const defaultMaxWorkers = parsePositiveInt(
      this.env.MAX_WORKERS_PER_POOL,
      DEFAULT_MAX_WORKERS_PER_POOL
    );

    const poolsWithWork = pools.filter((pool) =>
      pendingRequests.some((request) => requestMatchesPool(request, pool))
    );

    const slotsByPool = new Map<string, SlotState[]>();
    for (const pool of poolsWithWork) {
      const maxWorkers = pool.maxWorkers ?? defaultMaxWorkers;
      const slots: SlotState[] = [];
      for (let index = 0; index < maxWorkers; index++) {
        const stub = getContainer(
          this.env.POOL_WORKER,
          containerNameForSlot(pool.name, index)
        );
        const status = await stub.slotStatus();
        const lastLaunchAtMs = await this.ctx.storage.get<number>(
          `${SLOT_KEY_PREFIX}${pool.name}/${index}`
        );
        slots.push({ slotIndex: index, running: status.running, lastLaunchAtMs });
      }
      slotsByPool.set(pool.name, slots);
    }

    const requestLaunchTimes = new Map<string, number>();
    for (const request of pendingRequests) {
      const launchedAtMs = await this.ctx.storage.get<number>(
        `${REQUEST_KEY_PREFIX}${request.id}`
      );
      if (launchedAtMs !== undefined) {
        requestLaunchTimes.set(request.id, launchedAtMs);
      }
    }

    return planLaunches({
      pendingRequests,
      pools: poolsWithWork,
      slotsByPool,
      requestLaunchTimes,
      defaultMaxWorkersPerPool: defaultMaxWorkers,
      nowMs,
    });
  }

  private async executeLaunch(launch: PlannedLaunch): Promise<void> {
    const nowMs = Date.now();
    const stub = getContainer(this.env.POOL_WORKER, launch.containerName);
    const result = await stub.launch(launch.spec);
    console.log(
      `launch ${launch.containerName} for request ${launch.spec.requestId ?? "-"}: ` +
        `started=${result.started} state=${result.state}`
    );
    await this.ctx.storage.put(
      `${SLOT_KEY_PREFIX}${launch.spec.poolName}/${launch.slotIndex}`,
      nowMs
    );
    if (launch.spec.requestId !== undefined) {
      await this.ctx.storage.put(
        `${REQUEST_KEY_PREFIX}${launch.spec.requestId}`,
        nowMs
      );
    }
  }

  /**
   * Broadcast pass: whenever a pool's config fingerprint changes (first deploy,
   * repo list edited), boot one short-lived worker for it so the durable pool
   * rows (pool name x repo) exist on the Cursor side before any request is
   * started. That is what makes the pool selectable in the composer at zero
   * running containers.
   */
  private async broadcastPools(pools: PoolConfig[]): Promise<void> {
    for (const pool of pools) {
      const fingerprint = poolConfigFingerprint(pool);
      const storageKey = `${BROADCAST_KEY_PREFIX}${pool.name}`;
      const known = await this.ctx.storage.get<string>(storageKey);
      if (known === fingerprint) {
        continue;
      }
      if (pool.repos.length === 0) {
        // Current cursor-agent releases require a git checkout per worker
        // dir, so an any-repo pool cannot register a durable repo-less pool
        // row from here. It becomes discoverable per-repo as its workers
        // serve requests; list repos explicitly for up-front discovery.
        console.warn(
          `pool ${pool.name} has no repos configured; skipping broadcast`
        );
        await this.ctx.storage.put(storageKey, fingerprint);
        continue;
      }
      const stub = getContainer(
        this.env.POOL_WORKER,
        containerNameForBroadcast(pool.name)
      );
      await stub.launch({
        mode: "broadcast",
        poolName: pool.name,
        repoUrls: pool.repos,
        workerName: `cf-${pool.name}-broadcast`,
      });
      console.log(`broadcasted pool ${pool.name} (${pool.repos.length} repos)`);
      await this.ctx.storage.put(storageKey, fingerprint);
    }
  }

  /**
   * Drop request launch records once the request is no longer pending (it was
   * claimed or cancelled) and the cooldown window has passed, plus a TTL sweep
   * so storage cannot grow without bound.
   */
  private async pruneRequestRecords(
    pendingRequests: PendingRequest[]
  ): Promise<void> {
    const pendingIds = new Set(pendingRequests.map((request) => request.id));
    const records = await this.ctx.storage.list<number>({
      prefix: REQUEST_KEY_PREFIX,
    });
    const nowMs = Date.now();
    for (const [key, launchedAtMs] of records) {
      const requestId = key.slice(REQUEST_KEY_PREFIX.length);
      const expired = nowMs - launchedAtMs > REQUEST_RECORD_TTL_MS;
      if (expired || !pendingIds.has(requestId)) {
        await this.ctx.storage.delete(key);
      }
    }
  }
}
