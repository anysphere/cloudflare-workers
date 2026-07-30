import type { CursorPoolWorker } from "./container";
import type { PoolScheduler } from "./scheduler";

export interface Env {
  // Bindings (wrangler.jsonc)
  POOL_SCHEDULER: DurableObjectNamespace<PoolScheduler>;
  POOL_WORKER: DurableObjectNamespace<CursorPoolWorker>;
  REPO_SNAPSHOTS: R2Bucket;

  // Secrets
  /** Cursor team service-account API key. Required. */
  CURSOR_API_KEY: string;
  /** HTTPS clone username for private repos (e.g. "x-access-token"). */
  GIT_USERNAME?: string;
  /** HTTPS clone token/password for private repos. */
  GIT_TOKEN?: string;
  /** Bearer token protecting the /status and /tick admin routes. */
  ADMIN_TOKEN?: string;
  /** Bearer token for snapshot routes; defaults to CURSOR_API_KEY. */
  SNAPSHOT_AUTH_TOKEN?: string;

  // Vars
  POOLS: string;
  CURSOR_API_URL?: string;
  CURSOR_AGENT_ENDPOINT?: string;
  MAX_WORKERS_PER_POOL?: string;
  /** Warm floor per pool. Default 1; set 0 to scale fully to zero when idle. */
  MIN_WORKERS_PER_POOL?: string;
  WORKER_IDLE_RELEASE_TIMEOUT_SECONDS?: string;
  POLL_INTERVAL_SECONDS?: string;
  SNAPSHOT_MAX_AGE_SECONDS?: string;
  /**
   * Public URL of this Worker (https://<name>.<account>.workers.dev or a
   * custom route). Enables the post-clone snapshot cache; when unset the
   * containers fall back to a full clone on every boot.
   */
  WORKER_PUBLIC_URL?: string;
  /** Hard ceiling on one container's lifetime, seconds. Default 8h. */
  MAX_RUN_LIFETIME_SECONDS?: string;
}

export function snapshotAuthToken(env: Env): string {
  return env.SNAPSHOT_AUTH_TOKEN ?? env.CURSOR_API_KEY;
}
