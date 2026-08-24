# Run Cursor cloud agents on Cloudflare

This template runs [Cursor cloud agents](https://cursor.com/docs/cloud-agent/self-hosted-pool) inside [Cloudflare Containers](https://developers.cloudflare.com/containers/) that you control. Cursor hosts the agent loop. Each claimed request gets an isolated container: its own filesystem, process space, and outbound bridge.

After deploy, one container runs `agent worker controller --spawn ./spawn.sh`. The Worker isolate cannot run the binary; the container can. Cron (and `/health`) keep that controller container up.

Product routing is documented in the [self-hosted pool guide](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md) ([repo-less / any-repo](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#repo-less-pools), [pool names](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#pool-names), [multiple repo roots](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#register-multiple-repo-roots)). This template supports both [repo-bound](#run-a-repo-bound-agent) and [any-repo](#run-an-any-repo-agent) starts. `CURSOR_REPO_URL` is only set when the claim has a repo; it is not required to spawn.

## How it works

1. You start an agent at [cursor.com/agents](https://cursor.com/agents) and choose **Self-hosted**. Cursor records a pending private-worker request.
2. The controller container runs `agent worker controller --spawn /home/worker/spawn.sh --pool <CURSOR_POOL>`. The CLI polls, claims, and execs [`container/spawn.sh`](container/spawn.sh).
3. `spawn.sh` `POST`s `/spawn` on this Worker and returns as soon as Cloudflare accepts the start. Exit **0** means spawned, **1** retryable, **2+** fatal. It forwards every `CURSOR_*` field the controller injected, including `CURSOR_REPO_URL` when the claim has one.
4. A guest `CursorPoolWorker` container starts. If `CURSOR_REPO_URL` is set, it clones (or restores an R2 snapshot). If it is unset, it starts from an empty workspace with **no git remote**.
5. The guest runs `agent worker --worker-dir <dir> --pool <name> start` as a long-lived outbound bridge. Cursor keeps driving the agent loop.
6. When the worker is idle for `WORKER_IDLE_RELEASE_TIMEOUT_SECONDS` (default 300), the guest exits and the container stops.

## Key properties

| Property | Description |
| --- | --- |
| **Controller in a container** | `agent worker controller --spawn` runs inside Cloudflare, not on a laptop. |
| **Containers isolation** | Each spawn is one Cloudflare Container. Checkouts and processes are not shared with other runs. |
| **Durable Object** | `CursorPoolWorker` owns a single container. The instance named `controller` is the CLI; `POST /spawn` starts a guest. |
| **R2 snapshots** | Optional post-clone cache for repo-bound boots, keyed by the clone URL. A miss is a cold `git clone`, not a failure. Unused in any-repo mode. |
| **Outbound-only worker** | The guest opens an outbound connection to Cursor. This template does not expose inbound ports on the container. |

## Prerequisites

- A Cloudflare account with Workers, Containers, and R2 (Workers Paid).
- Node 20 or later. Docker if you build the container image locally; Wrangler builds it on `npx wrangler deploy`.
- A Cursor **service-account API key** with agent scope. Pool workers reject personal API keys.

The image pins a **lab** CLI in [`container/cursor-agent-version`](container/cursor-agent-version). Prod `cursor.com/install` (2026.08.04 and earlier) has no `worker controller` subcommand. See [CLI versions](#cli-versions).

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

3. Put secrets.

   ```bash
   npx wrangler secret put CURSOR_API_KEY       # team service-account key
   npx wrangler secret put SPAWN_TOKEN          # bearer for POST /spawn
   npx wrangler secret put GIT_USERNAME         # optional: e.g. x-access-token
   npx wrangler secret put GIT_TOKEN            # optional: PAT for private repos
   npx wrangler secret put SNAPSHOT_AUTH_TOKEN  # optional: defaults to SPAWN_TOKEN
   ```

4. In `wrangler.jsonc`, set:

   - `vars.CURSOR_POOL` to the pool name you will select in the dashboard (default `default`). Comma-separate to watch more than one name. Do not use `--all-pools` on a shared team account.
   - `vars.WORKER_PUBLIC_URL` to the URL this Worker will have (for example `https://cursor-pool-workers.<account>.workers.dev`). The controller POSTs `/spawn` here; it also enables the snapshot cache.

5. Deploy.

   ```bash
   npx wrangler deploy
   ```

Keep `containers[].max_instances` at least **1 +** the number of concurrent claimed runs you expect (one slot is the controller). `GET /health` is public and also wakes the controller. `POST /spawn` and `POST /stop` require `Authorization: Bearer <SPAWN_TOKEN>`.

Watch containers with `npx wrangler containers list`.

## Run a repo-bound agent

Routing is by **git remote**. Users pick the repo in the dashboard (the pool appears under that repo). Pool name is extra routing, not a substitute for the clone. Docs: [register multiple repo roots](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#register-multiple-repo-roots).

1. Open [cursor.com/agents](https://cursor.com/agents).
2. Start an agent, pick the repo, and choose **Self-hosted** with the `CURSOR_POOL` name.
3. The claim includes a clone URL. The controller injects `CURSOR_REPO_URL` (and usually `CURSOR_REPO_OWNER` / `CURSOR_REPO_NAME`).
4. The guest restores or clones that URL into `$HOME/workspaces/repo-0`, then starts:

   ```bash
   agent worker --worker-dir "$HOME/workspaces/repo-0" --pool "$CURSOR_POOL" start --verbose
   ```

The worker derives `repo=owner/name` from the git remote. Do not set `repo=` labels by hand.

Snapshots ([`src/snapshots.ts`](src/snapshots.ts)) are an optional R2 cache of that post-clone tree. Skip them if a cold clone every boot is fine. The public CLI accepts repeated `--worker-dir` (up to 20); this container starts a single root.

## Run an any-repo agent

Routing is by **pool name**, not by git remote. Docs: [repo-less pools](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#repo-less-pools).

1. Open [cursor.com/agents](https://cursor.com/agents).
2. Start an agent, pick the **Any repo** group, and choose the `CURSOR_POOL` name. From Slack/GitHub/Linear use `pool=<name>`. From the API use `env.type: "pool"` and `env.name`, and omit `repos`.
3. The claim has no repo. The controller does not set `CURSOR_REPO_URL`. `spawn.sh` still POSTs `/spawn`.
4. The guest creates `$HOME/workspaces/repo-0` with **no git remote** and starts:

   ```bash
   agent worker --worker-dir "$HOME/workspaces/repo-0" --pool "$CURSOR_POOL" start --verbose
   ```

The worker omits `repo=` labels. The pool name on the guest must match the controller (`CURSOR_POOL` in `wrangler.jsonc`). Repeat names as a comma-separated list to watch more than one pool.

If a later claim includes `CURSOR_REPO_URL` and the entrypoint clones it into `--worker-dir`, **that session becomes repo-bound**. To stay any-repo, keep `--worker-dir` as a directory with no git remote and let the agent or a hook clone into it.

## CLI versions (TODO: Remove before publishing)

| Channel | Version (today) | `worker controller` | Usable here? |
| --- | --- | --- | --- |
| Prod `cursor.com/install` | `2026.08.04-aaa8809` | No | No. The binary has no controller subcommand. |
| Lab `downloads.cursor.com/lab/…` | `2026.08.21-4bf0f61` | Yes | Pin this in `cursor-agent-version`. It still rejects extra pending-request fields — see below. |

`curl https://cursor.com/install?channel=lab` currently installs the same `2026.08.21-4bf0f61` build. There is no newer published lab tarball to pin.

That lab CLI parses `GET /v0/private-workers/pending-requests` with a **strict** schema. Production now returns `repoUrls` (and other extras). The controller then exits with `Unrecognized key(s) in object: 'repoUrls'` and will not claim. This is a CLI bug, not something this template can fix by wrapping the API. When a lab (or prod) build ships that ignores unknown keys, bump [`container/cursor-agent-version`](container/cursor-agent-version) and redeploy.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Worker never connects | Controller container not running, or `CURSOR_POOL` does not match the dashboard pool | Hit `/health`, check `wrangler tail`, confirm `CURSOR_API_KEY` and `WORKER_PUBLIC_URL`. |
| Controller logs `Unrecognized key(s) in object: 'repoUrls'` | Lab CLI `2026.08.21` strict-parses pending-requests | Wait for a CLI that ignores unknown keys; bump `cursor-agent-version`. |
| Agent cannot find the pool under a repo | You started [any-repo](#run-an-any-repo-agent) (no `repo=` labels) | Pick the **Any repo** group, or start [repo-bound](#run-a-repo-bound-agent) so the guest clones and advertises `repo=`. |
| `POST /spawn` returns 401 | `SPAWN_TOKEN` does not match what the controller container was given | Re-put `SPAWN_TOKEN` and redeploy so the controller picks up the new secret. |
| Snapshot miss / slow first boot | No R2 object yet, stale snapshot, or `WORKER_PUBLIC_URL` unset | Expected for [repo-bound](#run-a-repo-bound-agent). The guest does a cold clone. Unused in any-repo mode. |

## Related resources

- [Cloudflare Containers](https://developers.cloudflare.com/containers/)
- [Cursor self-hosted pools](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md) ([repo-less / any-repo](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#repo-less-pools), [pool names](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#pool-names), [multiple repo roots](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#register-multiple-repo-roots))
- [`container/spawn.sh`](container/spawn.sh) — spawn hook the controller execs
- [`wrangler.jsonc`](wrangler.jsonc) — Worker, Container, Durable Object, and R2 bindings
