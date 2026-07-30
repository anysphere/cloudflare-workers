/**
 * Shared types for the scheduler. This module is intentionally free of
 * Cloudflare imports so the planning logic can be unit-tested under plain
 * node/vitest.
 */

/** One Cursor worker pool this deployment serves. */
export interface PoolConfig {
  /** Pool label registered by workers (`agent worker --pool --pool-name`). */
  readonly name: string;
  /**
   * Repo clone URLs the pool's workers broadcast. Every worker launched for
   * this pool clones all of these and registers one durable pool row per repo,
   * so the pool shows up in the composer picker for each repo even at zero
   * connected workers. Empty means "any repo": workers clone whatever repo the
   * pending request references (or run repo-less when the request has none).
   */
  readonly repos: readonly string[];
  /** Per-pool override of MAX_WORKERS_PER_POOL. */
  readonly maxWorkers?: number;
}

/** A pending agent run returned by GET /v0/private-workers/pending-requests. */
export interface PendingRequest {
  readonly id: string;
  readonly repoOwner?: string;
  readonly repoName?: string;
  readonly repoUrl?: string;
  readonly labels: readonly { readonly key: string; readonly value: string }[];
  readonly createdAtMs: number;
}

/** Scheduler-side view of one container slot. */
export interface SlotState {
  readonly slotIndex: number;
  /** True when the container reports a running/healthy state. */
  readonly running: boolean;
  /** Last time the scheduler issued a launch for this slot, if any. */
  readonly lastLaunchAtMs?: number;
}

/** What the container entrypoint is asked to do. */
export type LaunchMode = "serve" | "broadcast";

/** Everything a container needs to boot one cursor-agent pool worker. */
export interface LaunchSpec {
  readonly mode: LaunchMode;
  readonly poolName: string;
  /** Repos to clone (and therefore broadcast) inside the container. */
  readonly repoUrls: readonly string[];
  /** Stable worker display name, useful in the Cursor dashboard. */
  readonly workerName: string;
  /** Pending request that triggered this launch (serve mode only). */
  readonly requestId?: string;
}

/** A launch decision made by the planner. */
export interface PlannedLaunch {
  readonly containerName: string;
  readonly spec: LaunchSpec;
  readonly slotIndex: number;
}
