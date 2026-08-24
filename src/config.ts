/** Defaults applied when the corresponding wrangler var is unset. */
export const DEFAULT_IDLE_RELEASE_TIMEOUT_SECONDS = 300;
export const DEFAULT_MAX_RUN_LIFETIME_SECONDS = 8 * 60 * 60;
export const DEFAULT_SNAPSHOT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_CURSOR_POOL = "default";

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
