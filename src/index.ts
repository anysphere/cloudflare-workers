/**
 * Worker entrypoint.
 *
 *   - POST /spawn starts a container for one claimed private-worker request
 *     (called by spawn.sh from `agent worker controller --spawn`);
 *   - snapshot routes let containers skip a full clone on boot.
 *
 * Poll, claim, and pool matching live in the agent CLI controller — not here.
 */
import { getContainer } from "@cloudflare/containers";
import { spawnAuthToken, type Env } from "./env";
import { handleSnapshotRequest } from "./snapshots";
import {
  containerNameForSpawn,
  guestEnvFromSpawn,
  parseSpawnBody,
  requireGuestSpawnEnv,
  SpawnRequestError,
} from "./spawn";

export { CursorPoolWorker } from "./container";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requireSpawnAuth(request: Request, env: Env): Response | undefined {
  const token = spawnAuthToken(env);
  if (token === undefined) {
    return new Response(
      "spawn disabled: set the SPAWN_TOKEN secret to enable POST /spawn",
      { status: 403 }
    );
  }
  const authorization = request.headers.get("Authorization") ?? "";
  if (authorization !== `Bearer ${token}`) {
    return new Response("unauthorized", { status: 401 });
  }
  return undefined;
}

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
  async fetch(request, env): Promise<Response> {
    const path = pathnameOf(request);

    if (path === "/" || path === "/health") {
      return json({ ok: true, service: "cursor-pool-workers" });
    }

    const snapshotMatch = path.match(/^\/internal\/snapshots\/([^/]+)$/);
    if (snapshotMatch !== null && snapshotMatch[1] !== undefined) {
      return handleSnapshotRequest(request, env, snapshotMatch[1]);
    }

    if (path === "/spawn" && request.method === "POST") {
      const denied = requireSpawnAuth(request, env);
      if (denied !== undefined) {
        return denied;
      }
      try {
        const body: unknown = await request.json();
        const guestEnv = guestEnvFromSpawn(parseSpawnBody(body));
        requireGuestSpawnEnv(guestEnv);
        const containerName = containerNameForSpawn(guestEnv);
        const stub = getContainer(env.POOL_WORKER, containerName);
        const result = await stub.spawnGuest(guestEnv);
        console.log(
          `spawn ${containerName} pool=${guestEnv.CURSOR_POOL ?? "-"} ` +
            `request=${guestEnv.CURSOR_REQUEST_ID ?? "-"} started=${result.started} state=${result.state}`
        );
        return json({
          started: result.started,
          state: result.state,
          containerName,
        });
      } catch (error) {
        if (error instanceof SpawnRequestError) {
          return json({ error: error.message }, error.status);
        }
        console.error(`spawn failed: ${String(error)}`);
        return json({ error: String(error) }, 500);
      }
    }

    if (path === "/stop" && request.method === "POST") {
      const denied = requireSpawnAuth(request, env);
      if (denied !== undefined) {
        return denied;
      }
      try {
        const body: unknown = await request.json();
        const guestEnv = guestEnvFromSpawn(parseSpawnBody(body));
        const containerName = containerNameForSpawn(guestEnv);
        const stub = getContainer(env.POOL_WORKER, containerName);
        await stub.stopWorker();
        return json({ stopped: containerName });
      } catch (error) {
        if (error instanceof SpawnRequestError) {
          return json({ error: error.message }, error.status);
        }
        console.error(`stop failed: ${String(error)}`);
        return json({ error: String(error) }, 500);
      }
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
