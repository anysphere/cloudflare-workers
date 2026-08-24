/**
 * Worker entrypoint.
 *
 * Cron (every minute) runs the controller: list pending requests for the pool,
 * watch the SSE stream, claim, and start one guest container per claim.
 * HTTP serves /health and the container<->R2 snapshot cache.
 */
import { getContainer } from "@cloudflare/containers";
import {
  CONTROLLER_RUN_BUDGET_MS,
  DEFAULT_CURSOR_API_URL,
  DEFAULT_CURSOR_POOL,
} from "./config";
import { guestEnvForClaim, runController } from "./controller";
import type { Env } from "./env";
import { handleSnapshotRequest } from "./snapshots";

export { CursorPoolWorker } from "./container";

function pathnameOf(request: Request): string {
  const url = request.url;
  const schemeEnd = url.indexOf("://");
  const pathStart = url.indexOf("/", schemeEnd === -1 ? 0 : schemeEnd + 3);
  const pathAndQuery = pathStart === -1 ? "/" : url.slice(pathStart);
  const queryStart = pathAndQuery.indexOf("?");
  const path = queryStart === -1 ? pathAndQuery : pathAndQuery.slice(0, queryStart);
  return path.replace(/\/+$/, "") || "/";
}

export default {
  async scheduled(_controller, env): Promise<void> {
    const apiKey = env.CURSOR_API_KEY;
    if (apiKey === undefined) {
      console.error("CURSOR_API_KEY secret is not set; controller idle");
      return;
    }
    const pool = env.CURSOR_POOL ?? DEFAULT_CURSOR_POOL;
    const summary = await runController({
      apiUrl: env.CURSOR_API_URL ?? DEFAULT_CURSOR_API_URL,
      apiKey,
      pool,
      budgetMs: CONTROLLER_RUN_BUDGET_MS,
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
  },

  async fetch(request, env): Promise<Response> {
    const path = pathnameOf(request);

    if (path === "/" || path === "/health") {
      return Response.json({ ok: true, service: "cursor-pool-workers" });
    }

    const snapshotMatch = path.match(/^\/internal\/snapshots\/([^/]+)$/);
    if (snapshotMatch !== null && snapshotMatch[1] !== undefined) {
      return handleSnapshotRequest(request, env, snapshotMatch[1]);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
