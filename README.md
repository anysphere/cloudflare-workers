# Run Cursor cloud agents on Cloudflare

This template runs [Cursor cloud agents](https://cursor.com/docs/cloud-agent/self-hosted-pool) inside [Cloudflare Containers](https://developers.cloudflare.com/containers/) that you control. Cursor hosts the agent loop. Each claimed request gets an isolated container: its own filesystem, process space, and outbound bridge.

You deploy a spawn-only Worker. The shared CLI (`agent worker controller --spawn`) polls Cursor, claims work, and calls this repo’s `spawn.sh`. This Worker does not poll pending requests or claim jobs.

## How it works

1. You start an agent at [cursor.com/agents](https://cursor.com/agents) and choose **Self-hosted** plus a pool name. Cursor records a pending private-worker request.
2. `agent worker controller --spawn` polls for that request, claims it, and execs `spawn.sh` with `CURSOR_*` in the environment.
3. `spawn.sh` `POST`s `/spawn` on this Worker and returns as soon as Cloudflare accepts the start. Exit **0** means spawned, **1** retryable, **2+** fatal.
4. A `CursorPoolWorker` container starts. It clones `CURSOR_REPO_URL`. If `WORKER_PUBLIC_URL` is set, it may restore a post-clone tarball from R2 first. [`src/snapshots.ts`](src/snapshots.ts) is that boot cache, not the controller.
5. The guest runs `cursor-agent worker start --pool` as a long-lived outbound bridge. Cursor keeps driving the agent loop.
6. When the worker is idle for `WORKER_IDLE_RELEASE_TIMEOUT_SECONDS` (default 300), the guest exits and the container stops.

## Key properties

| Property | Description |
| --- | --- |
| **Containers isolation** | Each spawn is one Cloudflare Container. Checkouts and processes are not shared with other runs. |
| **Durable Object** | `CursorPoolWorker` owns a single container. `POST /spawn` starts it and returns; it does not wait for `cursor-agent`. |
| **R2 snapshots** | Optional post-clone cache keyed by the clone URL. A miss is a cold `git clone`, not a failure. |
| **Outbound-only worker** | The guest opens an outbound connection to Cursor. This template does not expose inbound ports on the container. |

## Prerequisites

- A Cloudflare account with Workers, Containers, and R2 (Workers Paid).
- Node 20 or later. Docker if you build the container image locally; Wrangler builds it on `npx wrangler deploy`.
- A Cursor **service-account API key** with agent scope. Pool workers reject personal API keys.
- The agent CLI with `worker controller`. If `agent worker controller` is missing, install the [lab CLI](https://cursor.com/install?channel=lab) — prod `cursor.com/install` may still be too old:

```bash
curl https://cursor.com/install?channel=lab -fsS | bash
```

## Deploy

1. Clone this template and install dependencies.

   ```bash
   git clone https://github.com/anysphere/cloudflare-workers.git
   cd cloudflare-workers
   npm install
   ```

2. Create the R2 bucket named in [`wrangler.jsonc`](wrangler.jsonc).

   ```bash
   npx wrangler r2 bucket create cursor-pool-worker-snapshots
   ```

3. Put secrets. `SPAWN_TOKEN` is required.

   ```bash
   npx wrangler secret put SPAWN_TOKEN          # bearer for POST /spawn
   npx wrangler secret put GIT_USERNAME         # optional: e.g. x-access-token
   npx wrangler secret put GIT_TOKEN            # optional: PAT for private repos
   npx wrangler secret put SNAPSHOT_AUTH_TOKEN  # optional: defaults to SPAWN_TOKEN
   ```

   | Credential | Where | Purpose |
   | --- | --- | --- |
   | `SPAWN_TOKEN` | Wrangler secret | Bearer token for `POST /spawn` and `POST /stop`. |
   | `CLOUDFLARE_SPAWN_TOKEN` | Controller host env | Same value as `SPAWN_TOKEN`. |
   | `CLOUDFLARE_WORKER_URL` | Controller host env | Deployed Worker URL. `spawn.sh` POSTs `{url}/spawn`. |
   | `CURSOR_API_KEY` | Controller (`--api-key` or env) | Service-account key. The controller injects it into `spawn.sh`; the guest uses it to register. |
   | `GIT_USERNAME` / `GIT_TOKEN` | Optional Wrangler secrets | HTTPS clone of private repos. Injected at runtime via an in-memory credential helper — never written to disk, never stored in snapshots. |
   | `SNAPSHOT_AUTH_TOKEN` | Optional Wrangler secret | Container ↔ Worker snapshot routes. Defaults to `SPAWN_TOKEN`. |

4. In `wrangler.jsonc`, set `vars.WORKER_PUBLIC_URL` to the URL this Worker will have (for example `https://cursor-pool-workers.<account>.workers.dev`) so container boots can use the snapshot cache.

5. Deploy.

   ```bash
   npx wrangler deploy
   ```

Keep `containers[].max_instances` in `wrangler.jsonc` at least as large as the number of concurrent claimed runs you expect. `GET /health` is public. `POST /spawn` and `POST /stop` require `Authorization: Bearer <SPAWN_TOKEN>`.

## Run a cloud agent

1. Keep a controller running for the pool you will select. `--pool` is required unless you pass `--all-pools`. Repeat `--pool` to watch more than one name.
2. Open [cursor.com/agents](https://cursor.com/agents).
3. Start an agent, pick the repo, and choose **Self-hosted** with that pool name.
4. Watch containers with `npx wrangler containers list`.

The guest clones `CURSOR_REPO_URL` on boot, then connects outbound. If the controller is not running, the dashboard request stays pending.

## How the template works

This repo only starts a container. The CLI is the controller.

- **Poll** — `agent worker controller --spawn` polls Cursor for pending private-worker requests and claims them. This Worker does not call `GET /v0/private-workers/pending-requests` or `POST .../claim`.
- **Start** — `spawn.sh` `POST`s `/spawn`. The Durable Object starts one container. The entrypoint restores or clones the repo, then execs `cursor-agent worker start --pool`.
- **Terminate** — idle-release exits the guest (default 300s). `MAX_RUN_LIFETIME_SECONDS` (default 8h) force-stops a wedged container. `POST /stop` is an authenticated admin stop.

## Alternative: run the controller locally

On a machine that can reach the deployed Worker:

```bash
export CURSOR_API_KEY=...                    # service-account key
export CLOUDFLARE_WORKER_URL=https://cursor-pool-workers.<account>.workers.dev
export CLOUDFLARE_SPAWN_TOKEN=...            # same value as SPAWN_TOKEN

chmod +x spawn.sh
agent worker controller --spawn ./spawn.sh --pool default
```

(`cursor-agent worker controller` is the same binary.) The controller injects `CURSOR_*`. `spawn.sh` forwards them and returns immediately — it does not wait for `cursor-agent`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Worker never connects | Controller not running, or `--pool` does not match the dashboard pool | Start `agent worker controller --spawn ./spawn.sh --pool <name>`. Use `--all-pools` or repeat `--pool` for more than one name. |
| `POST /spawn` returns 401 | `CLOUDFLARE_SPAWN_TOKEN` does not match the Worker `SPAWN_TOKEN` | Re-put `SPAWN_TOKEN` and export the same value as `CLOUDFLARE_SPAWN_TOKEN`. |
| Snapshot miss / slow first boot | No R2 object yet, stale snapshot, or `WORKER_PUBLIC_URL` unset | Expected. The guest does a cold clone. Set `vars.WORKER_PUBLIC_URL` and redeploy to enable the cache. |
| `agent worker controller` not found | Prod install is too old | `curl https://cursor.com/install?channel=lab -fsS \| bash` |

## Related resources

- [Cloudflare Containers](https://developers.cloudflare.com/containers/)
- [Cursor self-hosted pools](https://cursor.com/docs/cloud-agent/self-hosted-pool)
- [`spawn.sh`](spawn.sh) — spawn hook the controller execs
- [`wrangler.jsonc`](wrangler.jsonc) — Worker, Container, Durable Object, and R2 bindings
