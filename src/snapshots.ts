import type { Env } from "./env";

/**
 * R2-backed snapshot cache for post-clone repo state.
 *
 * Container boots are ephemeral, so without help every boot pays a full
 * `git clone`. The entrypoint instead keys a tarball of the freshly cloned
 * repo by a digest of its clone URL and stores it here; subsequent boots
 * download the tarball and only run an incremental `git fetch`. Objects are
 * treated as a best-effort cache: entries older than SNAPSHOT_MAX_AGE_SECONDS
 * are rebuilt from a fresh clone by the entrypoint.
 *
 * Routes (bearer auth with the SNAPSHOT_AUTH_TOKEN secret; 401 when unset):
 *   HEAD /internal/snapshots/<key>  – existence + x-snapshot-created-at header
 *   GET  /internal/snapshots/<key>  – tarball stream
 *   PUT  /internal/snapshots/<key>  – upload tarball
 */

const KEY_PATTERN = /^[a-f0-9]{64}\.tar\.gz$/;
export const SNAPSHOT_CREATED_AT_HEADER = "x-snapshot-created-at";

function unauthorized(): Response {
  return new Response("unauthorized", { status: 401 });
}

export async function handleSnapshotRequest(
  request: Request,
  env: Env,
  key: string
): Promise<Response> {
  const token = env.SNAPSHOT_AUTH_TOKEN;
  if (token === undefined) {
    return unauthorized();
  }
  const authorization = request.headers.get("Authorization") ?? "";
  if (authorization !== `Bearer ${token}`) {
    return unauthorized();
  }
  if (!KEY_PATTERN.test(key)) {
    return new Response("invalid snapshot key", { status: 400 });
  }

  switch (request.method) {
    case "HEAD": {
      const head = await env.REPO_SNAPSHOTS.head(key);
      if (head === null) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, {
        status: 200,
        headers: {
          [SNAPSHOT_CREATED_AT_HEADER]: String(head.uploaded.getTime()),
          "content-length": String(head.size),
        },
      });
    }
    case "GET": {
      const object = await env.REPO_SNAPSHOTS.get(key);
      if (object === null) {
        return new Response("not found", { status: 404 });
      }
      return new Response(object.body, {
        status: 200,
        headers: {
          "content-type": "application/gzip",
          [SNAPSHOT_CREATED_AT_HEADER]: String(object.uploaded.getTime()),
        },
      });
    }
    case "PUT": {
      if (request.body === null) {
        return new Response("missing body", { status: 400 });
      }
      await env.REPO_SNAPSHOTS.put(key, request.body, {
        httpMetadata: { contentType: "application/gzip" },
        customMetadata: {
          repoUrl: request.headers.get("x-snapshot-repo-url") ?? "",
        },
      });
      return new Response("stored", { status: 200 });
    }
    default:
      return new Response("method not allowed", { status: 405 });
  }
}
