/**
 * Worker entrypoint.
 *
 *   - cron (`scheduled`) keeps the PoolScheduler's alarm loop armed;
 *   - `fetch` exposes a tiny admin surface plus the internal snapshot cache
 *     the containers use to skip full clones.
 *
 * The heavy lifting lives in the two Durable Object classes exported below.
 */
import { getContainer } from "@cloudflare/containers";
import type { Env } from "./env";
import { containerNameForSlot } from "./matching";
import { handleSnapshotRequest } from "./snapshots";

export { PoolScheduler } from "./scheduler";
export { CursorPoolWorker } from "./container";

const SCHEDULER_INSTANCE = "scheduler";

function schedulerStub(env: Env) {
  return env.POOL_SCHEDULER.get(env.POOL_SCHEDULER.idFromName(SCHEDULER_INSTANCE));
}

function requireAdmin(request: Request, env: Env): Response | undefined {
  if (env.ADMIN_TOKEN === undefined) {
    return new Response(
      "admin routes disabled: set the ADMIN_TOKEN secret to enable them",
      { status: 403 }
    );
  }
  const authorization = request.headers.get("Authorization") ?? "";
  if (authorization !== `Bearer ${env.ADMIN_TOKEN}`) {
    return new Response("unauthorized", { status: 401 });
  }
  return undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async scheduled(_controller, env): Promise<void> {
    await schedulerStub(env).ensureRunning();
  },

  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" || path === "/health") {
      return json({ ok: true, service: "cursor-pool-workers" });
    }

    const snapshotMatch = path.match(/^\/internal\/snapshots\/([^/]+)$/);
    if (snapshotMatch !== null && snapshotMatch[1] !== undefined) {
      return handleSnapshotRequest(request, env, snapshotMatch[1]);
    }

    if (path === "/status" && request.method === "GET") {
      const denied = requireAdmin(request, env);
      if (denied !== undefined) {
        return denied;
      }
      return json(await schedulerStub(env).getStatus());
    }

    if (path === "/tick" && request.method === "POST") {
      const denied = requireAdmin(request, env);
      if (denied !== undefined) {
        return denied;
      }
      const summary = await schedulerStub(env).tick();
      await schedulerStub(env).ensureRunning();
      return json(summary);
    }

    // Admin: force-stop one container slot, e.g. POST /slots/default/0/stop
    const slotStopMatch = path.match(/^\/slots\/([^/]+)\/(\d+)\/stop$/);
    if (slotStopMatch !== null && request.method === "POST") {
      const denied = requireAdmin(request, env);
      if (denied !== undefined) {
        return denied;
      }
      const [, poolName, slotIndex] = slotStopMatch;
      if (poolName === undefined || slotIndex === undefined) {
        return new Response("not found", { status: 404 });
      }
      const containerName = containerNameForSlot(poolName, Number(slotIndex));
      const stub = getContainer(env.POOL_WORKER, containerName);
      await stub.stopWorker();
      return json({ stopped: containerName });
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
