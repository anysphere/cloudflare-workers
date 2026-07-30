/**
 * Pure planning logic: which pending requests should cause a container launch.
 *
 * The Cursor backend performs the authoritative claim — a pending request is
 * assigned to whichever matching pool worker connects first, and it drops out
 * of the pending-requests listing at that moment. The planner's job is only to
 * make sure a matching worker exists: it maps each pending request to a
 * configured pool, picks a free container slot, and applies cooldowns so one
 * request never fans out into a thundering herd of containers.
 */
import type {
  PendingRequest,
  PlannedLaunch,
  PoolConfig,
  SlotState,
} from "./types";

/** Backend semantics: a request with no `pool` label targets pool "default". */
export const DEFAULT_POOL_NAME = "default";

/** Don't relaunch for the same request / slot within this window. */
export const LAUNCH_COOLDOWN_MS = 120_000;

/** Forget request launch records after this long (requests that never claim). */
export const REQUEST_RECORD_TTL_MS = 15 * 60_000;

/**
 * Canonicalize a git clone URL to an "owner/name" routing key, mirroring how
 * the Cursor backend derives the `repo` label (lower-cased, `.git` stripped).
 * Returns undefined for URLs that don't parse. Handles https://, ssh:// and
 * scp-like git@host:owner/repo forms.
 */
export function repoKeyFromUrl(rawUrl: string): string | undefined {
  let normalized = rawUrl.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalized.startsWith("git@")) {
    normalized =
      "https://" + normalized.slice("git@".length).replace(":", "/");
  } else if (normalized.startsWith("ssh://git@")) {
    normalized = "https://" + normalized.slice("ssh://git@".length);
  } else if (!/^https?:\/\//i.test(normalized)) {
    normalized = "https://" + normalized;
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return undefined;
  }
  const segments = parsed.pathname
    .replace(/\.git$/i, "")
    .split("/")
    .filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return undefined;
  }
  // Keep every path segment (GitLab nested groups): owner is everything but
  // the final segment.
  const name = segments[segments.length - 1];
  const owner = segments.slice(0, -1).join("/");
  if (name === undefined || owner.length === 0) {
    return undefined;
  }
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function repoKeyFromOwnerName(
  owner: string | undefined,
  name: string | undefined
): string | undefined {
  if (owner === undefined || name === undefined) {
    return undefined;
  }
  const trimmedOwner = owner.trim();
  const trimmedName = name.trim();
  if (trimmedOwner.length === 0 || trimmedName.length === 0) {
    return undefined;
  }
  return `${trimmedOwner.toLowerCase()}/${trimmedName.toLowerCase()}`;
}

/** Pool a pending request targets: its `pool` label, else "default". */
export function poolNameFromRequest(request: PendingRequest): string {
  const label = request.labels.find(
    (candidate) =>
      candidate.key === "pool" && candidate.value.trim().length > 0
  );
  return label?.value.trim() ?? DEFAULT_POOL_NAME;
}

function requestRepoKey(request: PendingRequest): string | undefined {
  return (
    repoKeyFromOwnerName(request.repoOwner, request.repoName) ??
    (request.repoUrl !== undefined ? repoKeyFromUrl(request.repoUrl) : undefined)
  );
}

/**
 * True when a worker launched for `pool` would be eligible to claim `request`:
 * the pool name matches, and either the pool serves any repo (no repos
 * configured) or the request's repo is one of the pool's broadcast repos.
 *
 * Requests without a resolvable repo are never matched: current cursor-agent
 * releases require every `--worker-dir` to be a git clone with an origin
 * remote, so a container launched here always registers repo-scoped and could
 * not claim a repo-less request anyway.
 */
export function requestMatchesPool(
  request: PendingRequest,
  pool: PoolConfig
): boolean {
  if (poolNameFromRequest(request) !== pool.name) {
    return false;
  }
  const requestKey = requestRepoKey(request);
  if (requestKey === undefined) {
    return false;
  }
  if (pool.repos.length === 0) {
    // Any-repo pool: the launched container clones the request's repo, so a
    // clone URL must be present.
    return request.repoUrl !== undefined;
  }
  return pool.repos.some((repoUrl) => repoKeyFromUrl(repoUrl) === requestKey);
}

/**
 * Repos the launched container should clone and broadcast for this request:
 * the pool's full broadcast list when configured, otherwise just the repo the
 * request references (or none, for repo-less pools serving repo-less requests).
 */
export function repoUrlsForLaunch(
  request: PendingRequest,
  pool: PoolConfig
): string[] {
  if (pool.repos.length > 0) {
    return [...pool.repos];
  }
  return request.repoUrl !== undefined ? [request.repoUrl] : [];
}

export function containerNameForSlot(
  poolName: string,
  slotIndex: number
): string {
  return `pool=${poolName}/slot=${slotIndex}`;
}

export function containerNameForBroadcast(poolName: string): string {
  return `pool=${poolName}/broadcast`;
}

export interface PlanLaunchesArgs {
  readonly pendingRequests: readonly PendingRequest[];
  readonly pools: readonly PoolConfig[];
  /** Slot states per pool name; missing pools are treated as all-free. */
  readonly slotsByPool: ReadonlyMap<string, readonly SlotState[]>;
  /** requestId -> last launch time, for request-level cooldown. */
  readonly requestLaunchTimes: ReadonlyMap<string, number>;
  readonly defaultMaxWorkersPerPool: number;
  readonly nowMs: number;
  readonly launchCooldownMs?: number;
}

/**
 * Decide which container slots to launch this tick. Oldest requests win when
 * slots are scarce. A slot is eligible when its container is not running and
 * it has not been launched within the cooldown window (a just-launched
 * container may not report running yet). A request is skipped when it was
 * already the subject of a recent launch — if it is still pending after the
 * cooldown (e.g. the container failed to boot), it gets retried.
 */
export function planLaunches(args: PlanLaunchesArgs): PlannedLaunch[] {
  const cooldownMs = args.launchCooldownMs ?? LAUNCH_COOLDOWN_MS;
  const launches: PlannedLaunch[] = [];
  const sortedRequests = [...args.pendingRequests].sort(
    (a, b) => a.createdAtMs - b.createdAtMs
  );

  for (const pool of args.pools) {
    const maxWorkers = pool.maxWorkers ?? args.defaultMaxWorkersPerPool;
    const knownSlots = args.slotsByPool.get(pool.name) ?? [];
    const slotByIndex = new Map<number, SlotState>(
      knownSlots.map((slot) => [slot.slotIndex, slot])
    );
    const freeSlotIndices: number[] = [];
    for (let index = 0; index < maxWorkers; index++) {
      const slot = slotByIndex.get(index);
      const inCooldown =
        slot?.lastLaunchAtMs !== undefined &&
        args.nowMs - slot.lastLaunchAtMs < cooldownMs;
      if (slot?.running !== true && !inCooldown) {
        freeSlotIndices.push(index);
      }
    }
    if (freeSlotIndices.length === 0) {
      continue;
    }

    let nextFreeSlot = 0;
    for (const request of sortedRequests) {
      if (nextFreeSlot >= freeSlotIndices.length) {
        break;
      }
      if (!requestMatchesPool(request, pool)) {
        continue;
      }
      const lastLaunchAtMs = args.requestLaunchTimes.get(request.id);
      if (
        lastLaunchAtMs !== undefined &&
        args.nowMs - lastLaunchAtMs < cooldownMs
      ) {
        continue;
      }
      const slotIndex = freeSlotIndices[nextFreeSlot];
      if (slotIndex === undefined) {
        break;
      }
      nextFreeSlot += 1;
      launches.push({
        containerName: containerNameForSlot(pool.name, slotIndex),
        slotIndex,
        spec: {
          mode: "serve",
          poolName: pool.name,
          repoUrls: repoUrlsForLaunch(request, pool),
          workerName: `cf-${pool.name}-${slotIndex}`,
          requestId: request.id,
        },
      });
    }
  }
  return launches;
}
