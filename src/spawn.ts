/**
 * Spawn-hook helpers. The agent CLI controller execs spawn.sh after a claim;
 * spawn.sh POSTs the injected CURSOR_* env here. This module is free of
 * Cloudflare imports so it can be unit-tested under node/vitest.
 */

/** Fleet-management base injected by the controller — not the guest bridge URL. */
const FLEET_API_ENV_KEYS = new Set(["CURSOR_API_URL", "CURSOR_API_ENDPOINT"]);

export class SpawnRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "SpawnRequestError";
  }
}

/**
 * Env the guest `cursor-agent worker start --pool` process actually reads.
 * The controller's CURSOR_API_URL / CURSOR_API_ENDPOINT are the public fleet
 * API (api.cursor.com); worker start treats CURSOR_API_ENDPOINT as the agent
 * bridge, so those two keys are stripped.
 */
export function guestEnvFromSpawn(
  input: Record<string, unknown>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!key.startsWith("CURSOR_")) {
      continue;
    }
    if (FLEET_API_ENV_KEYS.has(key)) {
      continue;
    }
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function parseSpawnBody(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SpawnRequestError(400, "spawn body must be a JSON object of CURSOR_* fields");
  }
  return raw as Record<string, unknown>;
}

/**
 * Durable Object / container instance name for this claim. Stable per
 * CURSOR_AGENT_WORKER_ID so a retry of the same claim hits the same slot.
 */
export function containerNameForSpawn(guestEnv: Record<string, string>): string {
  const id =
    guestEnv.CURSOR_AGENT_WORKER_ID ??
    guestEnv.CURSOR_REQUEST_ID ??
    guestEnv.CURSOR_BC_ID;
  if (id === undefined || id.trim().length === 0) {
    throw new SpawnRequestError(
      400,
      "spawn requires CURSOR_AGENT_WORKER_ID, CURSOR_REQUEST_ID, or CURSOR_BC_ID"
    );
  }
  const trimmed = id.trim();
  if (trimmed.length > 200) {
    throw new SpawnRequestError(400, "spawn worker id is too long");
  }
  return `spawn/${trimmed}`;
}

export function requireGuestSpawnEnv(guestEnv: Record<string, string>): void {
  if (guestEnv.CURSOR_API_KEY === undefined) {
    throw new SpawnRequestError(400, "spawn requires CURSOR_API_KEY");
  }
  if (guestEnv.CURSOR_POOL === undefined) {
    throw new SpawnRequestError(
      400,
      "spawn requires CURSOR_POOL (the controller sets this from the claimed request)"
    );
  }
  if (guestEnv.CURSOR_REPO_URL === undefined) {
    throw new SpawnRequestError(
      400,
      "spawn requires CURSOR_REPO_URL (cursor-agent needs a git checkout per worker dir)"
    );
  }
}

/** HTTP statuses the spawn hook should treat as retryable (exit 1). */
export function isRetryableSpawnStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}
