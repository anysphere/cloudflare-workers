import type { CursorPoolWorker } from "./container";

export interface Env {
  POOL_WORKER: DurableObjectNamespace<CursorPoolWorker>;
  REPO_SNAPSHOTS: R2Bucket;

  /** Bearer token protecting POST /spawn (and optional admin stop). Required for spawn. */
  SPAWN_TOKEN?: string;
  /** HTTPS clone username for private repos (e.g. "x-access-token"). */
  GIT_USERNAME?: string;
  /** HTTPS clone token/password for private repos. */
  GIT_TOKEN?: string;
  /** Bearer token for snapshot routes; defaults to SPAWN_TOKEN. */
  SNAPSHOT_AUTH_TOKEN?: string;
  /**
   * Optional guest agent/bridge URL (e.g. https://api2.cursor.sh). When unset
   * the in-container CLI uses its own default. Do not set this to the fleet
   * API (api.cursor.com) — that is CURSOR_API_ENDPOINT on the controller side.
   */
  CURSOR_AGENT_ENDPOINT?: string;
  WORKER_IDLE_RELEASE_TIMEOUT_SECONDS?: string;
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

export function spawnAuthToken(env: Env): string | undefined {
  return env.SPAWN_TOKEN;
}

export function snapshotAuthToken(env: Env): string | undefined {
  return env.SNAPSHOT_AUTH_TOKEN ?? env.SPAWN_TOKEN;
}
