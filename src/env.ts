import type { CursorPoolWorker } from "./container";

export interface Env {
  POOL_WORKER: DurableObjectNamespace<CursorPoolWorker>;
  REPO_SNAPSHOTS: R2Bucket;

  /** Cursor team service-account API key (secret). Claims requests; guests connect with it. */
  CURSOR_API_KEY?: string;
  /** Pool this Worker watches and claims from. Default `default`. */
  CURSOR_POOL?: string;
  /** Fleet API base. Default https://api.cursor.com. */
  CURSOR_API_URL?: string;
  /**
   * Optional guest agent/bridge URL. When unset the in-container CLI uses
   * its own default. Not the fleet API above.
   */
  CURSOR_AGENT_ENDPOINT?: string;
  /** HTTPS clone username for private repos (e.g. "x-access-token"). */
  GIT_USERNAME?: string;
  /** HTTPS clone token/password for private repos. */
  GIT_TOKEN?: string;
  /** Bearer token for the snapshot cache routes (secret). Unset disables the cache. */
  SNAPSHOT_AUTH_TOKEN?: string;
  /** Public URL of this Worker; guest boots use it for the snapshot cache. */
  WORKER_PUBLIC_URL?: string;
  WORKER_IDLE_RELEASE_TIMEOUT_SECONDS?: string;
  SNAPSHOT_MAX_AGE_SECONDS?: string;
  /** Hard ceiling on one guest container's lifetime, seconds. Default 8h. */
  MAX_RUN_LIFETIME_SECONDS?: string;
}
