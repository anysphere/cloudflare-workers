import type { PoolConfig } from "./types";

/** Defaults applied when the corresponding wrangler var is unset. */
export const DEFAULT_MAX_WORKERS_PER_POOL = 3;
export const DEFAULT_POLL_INTERVAL_SECONDS = 20;
export const DEFAULT_IDLE_RELEASE_TIMEOUT_SECONDS = 300;
export const DEFAULT_SNAPSHOT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const POOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/**
 * Parse and validate the POOLS var (a JSON array of pool configs). Throws with
 * an actionable message on malformed input so a bad deploy fails loudly on the
 * first tick instead of silently scheduling nothing.
 */
export function parsePoolsConfig(raw: string | undefined): PoolConfig[] {
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error("POOLS var is not set; configure it in wrangler.jsonc");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`POOLS is not valid JSON: ${String(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("POOLS must be a non-empty JSON array of pool configs");
  }
  const seen = new Set<string>();
  const pools: PoolConfig[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("Each POOLS entry must be an object");
    }
    const { name, repos, maxWorkers } = entry as {
      name?: unknown;
      repos?: unknown;
      maxWorkers?: unknown;
    };
    if (typeof name !== "string" || !POOL_NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid pool name ${JSON.stringify(name)}: use letters, digits, ".", "_", "-" (max 255 chars)`
      );
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate pool name "${name}" in POOLS`);
    }
    seen.add(name);
    const repoUrls: string[] = [];
    if (repos !== undefined) {
      if (!Array.isArray(repos)) {
        throw new Error(`Pool "${name}": repos must be an array of clone URLs`);
      }
      for (const repo of repos) {
        if (typeof repo !== "string" || repo.trim().length === 0) {
          throw new Error(`Pool "${name}": repos entries must be URLs`);
        }
        repoUrls.push(repo.trim());
      }
    }
    let maxWorkersValue: number | undefined;
    if (maxWorkers !== undefined) {
      if (
        typeof maxWorkers !== "number" ||
        !Number.isInteger(maxWorkers) ||
        maxWorkers < 1
      ) {
        throw new Error(`Pool "${name}": maxWorkers must be a positive integer`);
      }
      maxWorkersValue = maxWorkers;
    }
    pools.push({ name, repos: repoUrls, maxWorkers: maxWorkersValue });
  }
  return pools;
}

/** Parse a positive-integer wrangler var with a default. */
export function parsePositiveInt(
  raw: string | undefined,
  fallback: number
): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    return fallback;
  }
  return value;
}

/**
 * Stable fingerprint of a pool's broadcast-relevant config. When it changes
 * (new repo added, pool renamed) the scheduler re-broadcasts the pool so the
 * durable pool rows on the Cursor side match the config.
 */
export function poolConfigFingerprint(pool: PoolConfig): string {
  return JSON.stringify([pool.name, [...pool.repos].sort()]);
}
