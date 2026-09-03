/**
 * Worker entrypoint.
 *
 * Cron (every 5 minutes) runs the controller: list pending requests for the pool,
 * watch the SSE stream, claim, and start one guest container per claim.
 * HTTP serves /health and the container<->R2 snapshot cache.
 */
import { getContainer } from "@cloudflare/containers";
import {
  CONTROLLER_RUN_BUDGET_MS,
  DEFAULT_CURSOR_API_URL,
  DEFAULT_CURSOR_POOL,
  parsePositiveInt,
} from "./config";
import { guestEnvForClaim, runController, type ControllerSummary } from "./controller";
import type { Env } from "./env";
import { handleSnapshotRequest } from "./snapshots";

export { CursorPoolWorker } from "./container";

/** Parse a request URL (Workers always provide absolute URLs). */
function canonicalizeUrl(raw: string): URL {
  return new URL(raw);
}

function pathnameOf(request: Request): string {
  return canonicalizeUrl(request.url).pathname.replace(/\/+$/, "") || "/";
}

/** One controller pass: list, stream, claim, and start a container per claim. */
async function runOnce(env: Env, budgetMs: number): Promise<ControllerSummary> {
  const apiKey = env.CURSOR_API_KEY;
  if (apiKey === undefined) {
    throw new Error("CURSOR_API_KEY secret is not set");
  }
  const pool = env.CURSOR_POOL ?? DEFAULT_CURSOR_POOL;
  const summary = await runController({
    apiUrl: env.CURSOR_API_URL ?? DEFAULT_CURSOR_API_URL,
    apiKey,
    pool,
    budgetMs,
    log: (message) => console.log(`controller[${pool}]: ${message}`),
    spawn: async (request, workerId) => {
      const result = await getContainer(env.POOL_WORKER, `spawn/${workerId}`).spawnGuest(
        guestEnvForClaim(request, workerId, apiKey)
      );
      console.log(
        `spawn ${workerId} request=${request.id} repo=${request.repoUrl ?? "-"} ` +
          `started=${result.started} state=${result.state}`
      );
    },
  });
  console.log(
    `controller[${pool}]: run done listed=${summary.listed} claimed=${summary.claimed}`
  );
  return summary;
}

export default {
  async scheduled(_controller, env): Promise<void> {
    await runOnce(env, CONTROLLER_RUN_BUDGET_MS);
  },

  async fetch(request, env): Promise<Response> {
    const path = pathnameOf(request);

    if (path === "/" || path === "/health") {
      return Response.json({ ok: true, service: "cursor-pool-workers" });
    }

    // Manual controller pass (ops/debugging): POST /run?budget=<seconds>.
    if (path === "/run" && request.method === "POST") {
      const token = env.ADMIN_TOKEN;
      if (token === undefined || request.headers.get("Authorization") !== `Bearer ${token}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const budgetSeconds = parsePositiveInt(
        canonicalizeUrl(request.url).searchParams.get("budget") ?? undefined,
        30
      );
      try {
        return Response.json(await runOnce(env, Math.min(budgetSeconds, 600) * 1000));
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }

    const snapshotMatch = path.match(/^\/internal\/snapshots\/([^/]+)$/);
    if (snapshotMatch !== null && snapshotMatch[1] !== undefined) {
      return handleSnapshotRequest(request, env, snapshotMatch[1]);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
