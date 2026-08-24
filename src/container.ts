import { Container } from "@cloudflare/containers";
import {
  DEFAULT_IDLE_RELEASE_TIMEOUT_SECONDS,
  DEFAULT_MAX_RUN_LIFETIME_SECONDS,
  parsePositiveInt,
} from "./config";
import type { Env } from "./env";

const LAUNCHED_AT_STORAGE_KEY = "launched-at-ms";

/** One guest container running `agent worker start --pool` for one claim. */
export class CursorPoolWorker extends Container<Env> {
  // No ports: outbound-only. sleepAfter is a watchdog interval, not a
  // lifetime: onActivityExpired re-arms it until MAX_RUN_LIFETIME_SECONDS.
  override sleepAfter = "30m";

  /** Start this instance's worker process. Returns once Cloudflare accepts the start. */
  async spawnGuest(
    guestEnv: Record<string, string>
  ): Promise<{ started: boolean; state: string }> {
    const state = await this.getState();
    if (state.status === "running" || state.status === "healthy") {
      return { started: false, state: state.status };
    }
    await this.ctx.storage.put(LAUNCHED_AT_STORAGE_KEY, Date.now());
    await this.start({ envVars: this.buildEnvVars(guestEnv) });
    return { started: true, state: (await this.getState()).status };
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

  /** Guests renew until MAX_RUN_LIFETIME_SECONDS, then force-stop. */
  override async onActivityExpired(): Promise<void> {
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

  private buildEnvVars(guestEnv: Record<string, string>): Record<string, string> {
    const idleReleaseTimeoutSeconds = parsePositiveInt(
      this.env.WORKER_IDLE_RELEASE_TIMEOUT_SECONDS,
      DEFAULT_IDLE_RELEASE_TIMEOUT_SECONDS
    );
    const envVars: Record<string, string> = {
      ...guestEnv,
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
    if (
      this.env.WORKER_PUBLIC_URL !== undefined &&
      this.env.SNAPSHOT_AUTH_TOKEN !== undefined
    ) {
      envVars.SNAPSHOT_BASE_URL = `${this.env.WORKER_PUBLIC_URL.replace(/\/+$/, "")}/internal/snapshots`;
      envVars.SNAPSHOT_AUTH_TOKEN = this.env.SNAPSHOT_AUTH_TOKEN;
    }
    return envVars;
  }
}
