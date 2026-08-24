import { Container } from "@cloudflare/containers";
import {
  DEFAULT_CURSOR_POOL,
  DEFAULT_IDLE_RELEASE_TIMEOUT_SECONDS,
  DEFAULT_MAX_RUN_LIFETIME_SECONDS,
  parsePositiveInt,
} from "./config";
import { snapshotAuthToken, type Env } from "./env";

const LAUNCHED_AT_STORAGE_KEY = "launched-at-ms";
const GUEST_ENV_STORAGE_KEY = "guest-env";
const ROLE_STORAGE_KEY = "role";

export interface WorkerSlotStatus {
  readonly running: boolean;
  readonly status: string;
  readonly launchedAtMs?: number;
}

/**
 * One container instance. Named `controller` runs
 * `agent worker controller --spawn`. Every other name is a guest
 * `cursor-agent worker start --pool` process.
 */
export class CursorPoolWorker extends Container<Env> {
  // No ports: outbound-only. sleepAfter is a watchdog interval, not a
  // lifetime: onActivityExpired re-arms it (forever for the controller;
  // until MAX_RUN_LIFETIME_SECONDS for guests).
  override sleepAfter = "30m";

  /** Keep `agent worker controller --spawn` running on this instance. */
  async startController(): Promise<{ started: boolean; state: string }> {
    const state = await this.getState();
    if (state.status === "running" || state.status === "healthy") {
      return { started: false, state: state.status };
    }
    await this.ctx.storage.put(ROLE_STORAGE_KEY, "controller");
    await this.ctx.storage.put(LAUNCHED_AT_STORAGE_KEY, Date.now());
    await this.start({ envVars: this.controllerEnvVars() });
    return { started: true, state: (await this.getState()).status };
  }

  /**
   * Start (or confirm) this instance's worker process. Returns after the
   * container has been asked to start — does not wait for cursor-agent.
   */
  async spawnGuest(
    guestEnv: Record<string, string>
  ): Promise<{ started: boolean; state: string }> {
    const state = await this.getState();
    if (state.status === "running" || state.status === "healthy") {
      return { started: false, state: state.status };
    }
    await this.ctx.storage.put(ROLE_STORAGE_KEY, "guest");
    await this.ctx.storage.put(GUEST_ENV_STORAGE_KEY, guestEnv);
    await this.ctx.storage.put(LAUNCHED_AT_STORAGE_KEY, Date.now());
    await this.start({ envVars: this.buildEnvVars(guestEnv) });
    return { started: true, state: (await this.getState()).status };
  }

  async slotStatus(): Promise<WorkerSlotStatus> {
    const state = await this.getState();
    const launchedAtMs = await this.ctx.storage.get<number>(
      LAUNCHED_AT_STORAGE_KEY
    );
    return {
      running: state.status === "running" || state.status === "healthy",
      status: state.status,
      launchedAtMs,
    };
  }

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
   * The controller stays up for the life of the deploy. Guests renew until
   * MAX_RUN_LIFETIME_SECONDS, then force-stop.
   */
  override async onActivityExpired(): Promise<void> {
    const role = await this.ctx.storage.get<string>(ROLE_STORAGE_KEY);
    if (role === "controller") {
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

  private controllerEnvVars(): Record<string, string> {
    return {
      CURSOR_ROLE: "controller",
      CURSOR_API_KEY: this.env.CURSOR_API_KEY ?? "",
      CURSOR_POOL: this.env.CURSOR_POOL ?? DEFAULT_CURSOR_POOL,
      CLOUDFLARE_WORKER_URL: this.env.WORKER_PUBLIC_URL ?? "",
      CLOUDFLARE_SPAWN_TOKEN: this.env.SPAWN_TOKEN ?? "",
    };
  }

  private buildEnvVars(guestEnv: Record<string, string>): Record<string, string> {
    const idleReleaseTimeoutSeconds = parsePositiveInt(
      this.env.WORKER_IDLE_RELEASE_TIMEOUT_SECONDS,
      DEFAULT_IDLE_RELEASE_TIMEOUT_SECONDS
    );
    const envVars: Record<string, string> = {
      ...guestEnv,
      CURSOR_ROLE: "guest",
      CURSOR_WORKER_IDLE_RELEASE_TIMEOUT: String(idleReleaseTimeoutSeconds),
      SNAPSHOT_MAX_AGE_SECONDS: this.env.SNAPSHOT_MAX_AGE_SECONDS ?? "",
    };
    if (this.env.CURSOR_AGENT_ENDPOINT !== undefined) {
      envVars.CURSOR_API_ENDPOINT = this.env.CURSOR_AGENT_ENDPOINT;
    }
    if (this.env.GIT_USERNAME !== undefined) {
      envVars.GIT_USERNAME = this.env.GIT_USERNAME;
    }
    if (this.env.GIT_TOKEN !== undefined) {
      envVars.GIT_TOKEN = this.env.GIT_TOKEN;
    }
    const snapshotToken = snapshotAuthToken(this.env);
    if (this.env.WORKER_PUBLIC_URL !== undefined && snapshotToken !== undefined) {
      envVars.SNAPSHOT_BASE_URL = `${this.env.WORKER_PUBLIC_URL.replace(/\/+$/, "")}/internal/snapshots`;
      envVars.SNAPSHOT_AUTH_TOKEN = snapshotToken;
    }
    return envVars;
  }
}
