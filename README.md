# Run Cursor cloud agents on Cloudflare

This template runs [Cursor cloud agents](https://cursor.com/docs/cloud-agent/self-hosted-pool) inside [Cloudflare Containers](https://developers.cloudflare.com/containers/) that you control. Cursor hosts the agent loop. Each claimed request gets an isolated container: its own filesystem, process space, and outbound bridge.

You deploy a spawn-only Worker. The shared CLI (`agent worker controller --spawn`) polls Cursor, claims work, and calls this repo’s `spawn.sh`. This Worker does not poll pending requests or claim jobs.

## How it works

1. You start an agent at [cursor.com/agents](https://cursor.com/agents) and choose **Self-hosted**. For a [repo-bound](#repo-bound-mode) pool, pick the repo (the pool appears under that repo). For an [any-repo](#any-repo-mode) pool, pick the **Any repo** group and the pool name. Cursor records a pending private-worker request.
2. `agent worker controller --spawn` polls for that request, claims it, and execs `spawn.sh` with `CURSOR_*` in the environment.
3. `spawn.sh` `POST`s `/spawn` on this Worker and returns as soon as Cloudflare accepts the start. Exit **0** means spawned, **1** retryable, **2+** fatal.
4. A `CursorPoolWorker` container starts. As shipped, it clones `CURSOR_REPO_URL` (required by `spawn.sh` and the entrypoint). If `WORKER_PUBLIC_URL` is set, it may restore a post-clone tarball from R2 first. [`src/snapshots.ts`](src/snapshots.ts) is that optional boot cache for repo-bound clones, not the controller.
5. The guest runs `agent worker --worker-dir <clone> --pool <name> start` as a long-lived outbound bridge. Cursor keeps driving the agent loop. Starting from that git remote makes the session [repo-bound](#repo-bound-mode).
6. When the worker is idle for `WORKER_IDLE_RELEASE_TIMEOUT_SECONDS` (default 300), the guest exits and the container stops.

## Key properties

| Property | Description |
| --- | --- |
| **Containers isolation** | Each spawn is one Cloudflare Container. Checkouts and processes are not shared with other runs. |
| **Durable Object** | `CursorPoolWorker` owns a single container. `POST /spawn` starts it and returns; it does not wait for `cursor-agent`. |
| **R2 snapshots** | Optional post-clone cache for [repo-bound](#repo-bound-mode) boots, keyed by the clone URL. A miss is a cold `git clone`, not a failure. Skip the cache if a cold clone every boot is fine. |
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

1. Keep a controller running for the pool you will select:

   ```bash
   agent worker controller --spawn ./spawn.sh --pool <name>
   ```

   `--pool` is required unless you pass `--all-pools`. Repeat `--pool` to watch more than one name. The pool name on the guest must match the controller.
2. Open [cursor.com/agents](https://cursor.com/agents).
3. Start an agent. For [repo-bound mode](#repo-bound-mode), pick the repo and choose **Self-hosted** with that pool name. For [any-repo mode](#any-repo-mode), pick the **Any repo** group and the pool name (`pool=<name>` on Slack/GitHub/Linear, or API `env.type: "pool"` + `env.name` with `repos` omitted).
4. Watch containers with `npx wrangler containers list`.

As shipped, the guest clones `CURSOR_REPO_URL` on boot, then connects outbound from that git checkout. If the controller is not running, the dashboard request stays pending.

## Pool and repo modes

Product routing is documented in the [self-hosted pool guide](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md) ([repo-less pools](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#repo-less-pools), [pool names](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#pool-names), [register multiple repo roots](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#register-multiple-repo-roots)).

**This template ships repo-bound.** `spawn.sh` exits 2 if `CURSOR_REPO_URL` is missing (`this template needs a git checkout per worker`). The Worker rejects the same payload. The container entrypoint clones that URL (or restores a snapshot), then starts the guest from the checkout:

```bash
agent worker --worker-dir "$HOME/workspaces/repo-0" --pool "$CURSOR_POOL" start --verbose
```

The worker derives `repo=owner/name` from the git remote. Do not set `repo=` labels by hand.

### Any-repo mode

Dashboard: **Any repo**. Docs: [repo-less](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#repo-less-pools).

Routing is by **pool name**, not by git remote. Users must specify the pool name(s) when starting an agent (dashboard **Any repo** group, `pool=<name>` on Slack/GitHub/Linear, or API `env.type: "pool"` + `env.name`, omit `repos`).

Controller:

```bash
agent worker controller --spawn ./spawn.sh --pool <name>
```

Repeat `--pool` for several names.

Guest — `<dir>` has **no git remote**, so the worker omits `repo=` labels. The pool name on the guest must match the controller:

```bash
agent worker --pool <name> --worker-dir <dir> start
```

Optional: at container start, clone the repo(s) specified on the pending request. The controller injects `CURSOR_REPO_URL`, `CURSOR_REPO_OWNER`, and `CURSOR_REPO_NAME` when the claim has a repo; `spawn.sh` forwards every `CURSOR_*` field. If those are set, you may clone before worker start. If you then start the worker from that git remote, **this session becomes repo-bound**. To stay any-repo, keep `--worker-dir` as a non-git directory and let the agent or a hook clone into it.

The shipped entrypoint always clones `CURSOR_REPO_URL` and passes that checkout as `--worker-dir`, so a spawn through this template is repo-bound even when the user picked **Any repo**.

### Repo-bound mode

Clone the repo in the **snapshot** ([`src/snapshots.ts`](src/snapshots.ts) is this repo’s R2 cache of a post-clone `tar.gz` for ephemeral Containers — optional; skip it if a cold clone every boot is fine) **or** clone on container start from `CURSOR_REPO_URL`, then point the worker at that git root (`cd` or `--worker-dir`). The worker derives `repo=owner/name` from the git remote. Do not set `repo=` labels by hand.

That is this template’s boot path: `restore_or_clone` into `$HOME/workspaces/repo-0`, then one `--worker-dir` at that checkout.

Multi-root: the public CLI accepts repeated `--worker-dir` (up to 20); the first is primary. This container starts a single `--worker-dir`.

Users pick the repo in the dashboard (the pool appears under that repo). Pool name is optional extra routing.

## How the template works

This repo only starts a container. The CLI is the controller.

- **Poll** — `agent worker controller --spawn` polls Cursor for pending private-worker requests and claims them. This Worker does not call `GET /v0/private-workers/pending-requests` or `POST .../claim`.
- **Start** — `spawn.sh` `POST`s `/spawn`. The Durable Object starts one container. The entrypoint restores or clones `CURSOR_REPO_URL`, then execs `agent worker --worker-dir <clone> --pool <name> start` (repo-bound).
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

(`cursor-agent worker controller` is the same binary.) The controller injects `CURSOR_REQUEST_ID`, `CURSOR_BC_ID`, `CURSOR_REPO_URL`, `CURSOR_REPO_OWNER`, `CURSOR_REPO_NAME`, `CURSOR_USER_ID`, `CURSOR_POOL`, `CURSOR_WORKER_NAME`, `CURSOR_API_URL` / `CURSOR_API_ENDPOINT`, `CURSOR_API_KEY`, and `CURSOR_AGENT_WORKER_ID`. `spawn.sh` forwards every `CURSOR_*` field and returns immediately — it does not wait for `cursor-agent`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Worker never connects | Controller not running, or `--pool` does not match the dashboard pool | Start `agent worker controller --spawn ./spawn.sh --pool <name>`. Use `--all-pools` or repeat `--pool` for more than one name. |
| `spawn.sh` exits 2 (`CURSOR_REPO_URL is missing`) | This template requires a clone URL on the claimed request | Start a [repo-bound](#repo-bound-mode) agent (pick the repo). As shipped, `spawn.sh` and the entrypoint do not stay [any-repo](#any-repo-mode). |
| `POST /spawn` returns 401 | `CLOUDFLARE_SPAWN_TOKEN` does not match the Worker `SPAWN_TOKEN` | Re-put `SPAWN_TOKEN` and export the same value as `CLOUDFLARE_SPAWN_TOKEN`. |
| Snapshot miss / slow first boot | No R2 object yet, stale snapshot, or `WORKER_PUBLIC_URL` unset | Expected for [repo-bound](#repo-bound-mode). The guest does a cold clone. Set `vars.WORKER_PUBLIC_URL` and redeploy to enable the cache. |
| `agent worker controller` not found | Prod install is too old | `curl https://cursor.com/install?channel=lab -fsS \| bash` |

## Related resources

- [Cloudflare Containers](https://developers.cloudflare.com/containers/)
- [Cursor self-hosted pools](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md) ([repo-less / any-repo](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#repo-less-pools), [pool names](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#pool-names), [multiple repo roots](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#register-multiple-repo-roots))
- [`spawn.sh`](spawn.sh) — spawn hook the controller execs
- [`wrangler.jsonc`](wrangler.jsonc) — Worker, Container, Durable Object, and R2 bindings
