import { Container } from "@cloudflare/containers";
import { parsePositiveInt, DEFAULT_IDLE_RELEASE_TIMEOUT_SECONDS } from "./config";
import { snapshotAuthToken, type Env } from "./env";
import type { LaunchSpec } from "./types";

const DEFAULT_MAX_RUN_LIFETIME_SECONDS = 8 * 60 * 60;
/** Broadcast boots only need to register the pool, then exit quickly. */
const BROADCAST_IDLE_RELEASE_TIMEOUT_SECONDS = 30;

const SPEC_STORAGE_KEY = "launch-spec";
const LAUNCHED_AT_STORAGE_KEY = "launched-at-ms";

export interface WorkerSlotStatus {
  readonly running: boolean;
  readonly status: string;
  readonly spec?: LaunchSpec;
  readonly launchedAtMs?: number;
}

/**
 * One container slot. The container image runs a single `cursor-agent worker
 * start --pool` process (see container/entrypoint.sh); when that process exits
 * — after the idle-release timeout, or when the run finishes and no follow-up
 * arrives — the container stops and the slot scales back to zero. The Durable
 * Object itself is durable and free while stopped.
 */
export class CursorPoolWorker extends Container<Env> {
  // No ports: the workload is an outbound-only bridge connection to Cursor.
  // sleepAfter acts as a watchdog interval, not a lifetime: onActivityExpired
  // re-arms it until MAX_RUN_LIFETIME_SECONDS, then force-stops the container.
  override sleepAfter = "30m";

  /** Start (or confirm) this slot's worker process for the given spec. */
  async launch(spec: LaunchSpec): Promise<{ started: boolean; state: string }> {
    const state = await this.getState();
    if (state.status === "running" || state.status === "healthy") {
      return { started: false, state: state.status };
    }
    await this.ctx.storage.put(SPEC_STORAGE_KEY, spec);
    await this.ctx.storage.put(LAUNCHED_AT_STORAGE_KEY, Date.now());
    await this.start({ envVars: this.buildEnvVars(spec) });
    return { started: true, state: (await this.getState()).status };
  }

  /** Scheduler-facing view used for slot planning and /status. */
  async slotStatus(): Promise<WorkerSlotStatus> {
    const state = await this.getState();
    const spec = await this.ctx.storage.get<LaunchSpec>(SPEC_STORAGE_KEY);
    const launchedAtMs = await this.ctx.storage.get<number>(
      LAUNCHED_AT_STORAGE_KEY
    );
    return {
      running: state.status === "running" || state.status === "healthy",
      status: state.status,
      spec,
      launchedAtMs,
    };
  }

  /** Admin: force-stop this slot's container. */
  async stopWorker(): Promise<void> {
    await this.stop();
  }

  override onStart(): void {
    console.log(`container started: ${JSON.stringify(this.ctx.id)}`);
  }

  override onStop(params: { exitCode: number; reason: string }): void {
    console.log(
      `container stopped (exitCode=${params.exitCode}, reason=${params.reason})`
    );
  }

  override onError(error: unknown): void {
    console.error(`container error: ${String(error)}`);
  }

  /**
   * Keep long agent runs alive across sleepAfter windows, but enforce a hard
   * lifetime ceiling so a wedged process cannot burn container hours forever.
   * Warm-floor workers renew indefinitely — the scheduler maintains the floor.
   */
  override async onActivityExpired(): Promise<void> {
    const spec = await this.ctx.storage.get<LaunchSpec>(SPEC_STORAGE_KEY);
    if (spec?.mode === "warm") {
      this.renewActivityTimeout();
      return;
    }
    const launchedAtMs =
      (await this.ctx.storage.get<number>(LAUNCHED_AT_STORAGE_KEY)) ?? 0;
    const maxLifetimeMs =
      parsePositiveInt(
        this.env.MAX_RUN_LIFETIME_SECONDS,
        DEFAULT_MAX_RUN_LIFETIME_SECONDS
      ) * 1000;
    if (Date.now() - launchedAtMs < maxLifetimeMs) {
      this.renewActivityTimeout();
      return;
    }
    console.warn("max run lifetime exceeded; stopping container");
    await this.stop();
  }

  private buildEnvVars(spec: LaunchSpec): Record<string, string> {
    // Warm floor workers must stay connected (idle-release 0) or the pool
    // disappears from the Cursor UI again. Broadcast boots are short-lived.
    // Serve launches use the configured idle timeout.
    const idleReleaseTimeoutSeconds =
      spec.mode === "broadcast"
        ? BROADCAST_IDLE_RELEASE_TIMEOUT_SECONDS
        : spec.mode === "warm"
          ? 0
          : parsePositiveInt(
              this.env.WORKER_IDLE_RELEASE_TIMEOUT_SECONDS,
              DEFAULT_IDLE_RELEASE_TIMEOUT_SECONDS
            );
    const envVars: Record<string, string> = {
      CURSOR_API_KEY: this.env.CURSOR_API_KEY,
      CURSOR_WORKER_POOL_NAME: spec.poolName,
      CURSOR_WORKER_NAME: spec.workerName,
      CURSOR_WORKER_IDLE_RELEASE_TIMEOUT: String(idleReleaseTimeoutSeconds),
      LAUNCH_MODE: spec.mode,
      // Newline-separated so URLs never need escaping.
      REPO_URLS: spec.repoUrls.join("\n"),
      SNAPSHOT_MAX_AGE_SECONDS: this.env.SNAPSHOT_MAX_AGE_SECONDS ?? "",
    };
    if (this.env.CURSOR_AGENT_ENDPOINT !== undefined) {
      envVars.CURSOR_AGENT_ENDPOINT = this.env.CURSOR_AGENT_ENDPOINT;
    }
    if (this.env.GIT_USERNAME !== undefined) {
      envVars.GIT_USERNAME = this.env.GIT_USERNAME;
    }
    if (this.env.GIT_TOKEN !== undefined) {
      envVars.GIT_TOKEN = this.env.GIT_TOKEN;
    }
    if (this.env.WORKER_PUBLIC_URL !== undefined) {
      envVars.SNAPSHOT_BASE_URL = `${this.env.WORKER_PUBLIC_URL.replace(/\/+$/, "")}/internal/snapshots`;
      envVars.SNAPSHOT_AUTH_TOKEN = snapshotAuthToken(this.env);
    }
    return envVars;
  }
}
