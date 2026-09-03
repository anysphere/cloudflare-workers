# Run Cursor cloud agents on Cloudflare

This template runs [Cursor cloud agents](https://cursor.com/docs/cloud-agent/self-hosted/pool) on [Self-Hosted Machines](https://cursor.com/docs/cloud-agent/self-hosted) inside [Cloudflare Containers](https://developers.cloudflare.com/containers/) that you control. Cursor hosts the agent loop. Each claimed request gets an isolated container: its own filesystem, process space, and outbound bridge.

The Worker itself is the controller. A cron trigger fires every five minutes; each run lists pending requests for your pool, holds the pending-requests **SSE stream** open until the next run is due, claims each request, and starts one guest container per claim. There is no controller binary, no long-running controller container, and no state outside Cursor's claim API.

Product routing is documented in the [Team Pools guide](https://cursor.com/docs/cloud-agent/self-hosted/pool) ([any-repo pools](https://cursor.com/docs/cloud-agent/self-hosted/pool#any-repo-pools), [pool names](https://cursor.com/docs/cloud-agent/self-hosted/pool#pool-names), [multiple repo roots](https://cursor.com/docs/cloud-agent/self-hosted/pool#register-multiple-repo-roots)). This template supports both [repo-bound](#run-a-repo-bound-agent) and [any-repo](#run-an-any-repo-agent) starts.

## How it works

1. You start an agent at [cursor.com/agents](https://cursor.com/agents) and choose **Self-hosted**. Cursor records a pending private-worker request.
2. Every five minutes the cron runs [`src/controller.ts`](src/controller.ts):
   - `POST /v0/private-workers/pools` — idempotently registers `CURSOR_POOL` as a durable team-level any-repo pool, so it is selectable before the first guest connects.
   - `GET /v0/private-workers/pending-requests?pool=<CURSOR_POOL>` — claims anything already waiting and returns a `streamCursor`.
   - `GET /v0/private-workers/pending-requests/stream?pool=…&cursor=…` — stays open for ~4m50s (`CONTROLLER_RUN_BUDGET_MS`) and claims each `created` event as it arrives, so coverage is continuous across runs. A `410` (expired cursor) or any server-side close re-lists, which also renews the cursor's five-minute lifetime.
3. `POST /v0/private-workers/claim` with a fresh `cf-<uuid>` worker id is the only mutex. `409` means another controller won; `404` means the request is gone. Overlapping cron runs are harmless.
4. On a successful claim the Worker starts a guest `CursorPoolWorker` container named `spawn/<workerId>` with the `CURSOR_*` env for that request. If the claim has a repo, `CURSOR_REPO_URL` is set and the guest clones (or restores an R2 snapshot). If not, the guest starts from an empty workspace with **no git remote**.
5. The guest runs `agent worker --worker-dir <dir> --pool <name> start` as a long-lived outbound bridge. Cursor keeps driving the agent loop.
6. When the worker is idle for `WORKER_IDLE_RELEASE_TIMEOUT_SECONDS` (default 300), the guest exits and the container stops.

## Key properties

| Property | Description |
| --- | --- |
| **Worker is the controller** | One TypeScript module in the Worker lists, streams, and claims. Nothing else runs between claims. |
| **Containers isolation** | Each claim is one Cloudflare Container. Checkouts and processes are not shared with other runs. |
| **Durable Object** | `CursorPoolWorker` owns a single guest container and enforces `MAX_RUN_LIFETIME_SECONDS`. |
| **R2 snapshots** | Optional post-clone cache for repo-bound boots, keyed by the clone URL. A miss is a cold `git clone`, not a failure. Unused in any-repo mode. |
| **Outbound-only** | The guest opens an outbound connection to Cursor. No inbound ports on the container; the Worker only serves `/health` and the snapshot routes. |

## Prerequisites

- A Cloudflare account with Workers, Containers, and R2 (Workers Paid).
- Node 20 or later. Docker if you build the container image locally; Wrangler builds it on `npx wrangler deploy`.
- A Cursor **service-account API key** with agent scope. Pool workers reject personal API keys.

The image installs the current prod CLI with `curl -fsSL https://cursor.com/install | bash`; the guest only needs `agent worker start`.

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
   npx wrangler secret put CURSOR_API_KEY       # team service-account key (required)
   npx wrangler secret put GIT_USERNAME         # optional: e.g. x-access-token
   npx wrangler secret put GIT_TOKEN            # optional: PAT for private repos
   npx wrangler secret put SNAPSHOT_AUTH_TOKEN  # optional: enables the R2 snapshot cache
   ```

4. In `wrangler.jsonc`, set `vars.CURSOR_POOL` to the pool name you will select in the dashboard (default `default`). The first controller pass automatically registers it as a team-level any-repo pool. For the snapshot cache also set `vars.WORKER_PUBLIC_URL` to this Worker's URL (for example `https://cursor-pool-workers.<account>.workers.dev`).

5. Deploy.

   ```bash
   npx wrangler deploy
   ```

Keep `containers[].max_instances` at least the number of concurrent claimed runs you expect. Watch containers with `npx wrangler containers list` and the controller with `npx wrangler tail`.

To run one controller pass on demand (without waiting for the cron), set the optional `ADMIN_TOKEN` secret and call `curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "https://<worker>/run?budget=60"`; the response is `{listed, claimed}` after the budget (seconds) elapses. To change the interval, edit `triggers.crons` in `wrangler.jsonc` and `CONTROLLER_RUN_BUDGET_MS` in [`src/config.ts`](src/config.ts) together.

## Run a repo-bound agent

Routing is by **git remote**. Users pick the repo in the dashboard (the pool appears under that repo). Pool name is extra routing, not a substitute for the clone. Docs: [register multiple repo roots](https://cursor.com/docs/cloud-agent/self-hosted/pool#register-multiple-repo-roots).

1. Open [cursor.com/agents](https://cursor.com/agents).
2. Start an agent, pick the repo, and choose **Self-hosted** with the `CURSOR_POOL` name.
3. The pending request includes a clone URL. After claiming, the Worker sets `CURSOR_REPO_URL` (and `CURSOR_REPO_OWNER` / `CURSOR_REPO_NAME`) on the guest.
4. The guest restores or clones that URL into `$HOME/workspaces/repo-0` (scheme-less identities such as `github.com/owner/repo` get `https://` prepended first), then starts:

   ```bash
   agent worker --worker-dir "$HOME/workspaces/repo-0" --pool "$CURSOR_POOL" start --verbose
   ```

The worker derives `repo=owner/name` from the git remote. Do not set `repo=` labels by hand.

Snapshots ([`src/snapshots.ts`](src/snapshots.ts)) are an optional R2 cache of that post-clone tree, enabled when both `WORKER_PUBLIC_URL` and `SNAPSHOT_AUTH_TOKEN` are set. Skip them if a cold clone every boot is fine. The public CLI accepts repeated `--worker-dir` (up to 20); this container starts a single root.

## Run an any-repo agent

Routing is by **pool name**, not by git remote. Docs: [any-repo pools](https://cursor.com/docs/cloud-agent/self-hosted/pool#any-repo-pools).

1. Open [cursor.com/agents](https://cursor.com/agents).
2. Start an agent, pick the **Any repo** group, and choose the `CURSOR_POOL` name. From Slack/GitHub/Linear use `pool=<name>`. From the API use `env.type: "pool"` and `env.name`, and omit `repos`.
3. The pending request has no repo, so the Worker does not set `CURSOR_REPO_URL`.
4. The guest creates `$HOME/workspaces/repo-0` with **no git remote** and starts:

   ```bash
   agent worker --worker-dir "$HOME/workspaces/repo-0" --pool "$CURSOR_POOL" start --verbose
   ```

The worker omits `repo=` labels. The pool name on the guest comes from the request's `pool` label (falling back to `default`), the same rule the official CLI controller uses.

If a later claim includes `CURSOR_REPO_URL` and the entrypoint clones it into `--worker-dir`, **that session becomes repo-bound**. To stay any-repo, keep `--worker-dir` as a directory with no git remote and let the agent or a hook clone into it.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Nothing is ever claimed | Cron not firing, `CURSOR_API_KEY` unset, or `CURSOR_POOL` does not match the dashboard pool | `npx wrangler tail`; look for `controller[<pool>]: run done` every five minutes and any `HTTP 401`. |
| `HTTP 401` in the controller log | Personal key, or a service-account key without agent scope | Put a team service-account key with agent scope as `CURSOR_API_KEY`. |
| Agent cannot find the pool under a repo | You started [any-repo](#run-an-any-repo-agent) (no `repo=` labels) | Pick the **Any repo** group, or start [repo-bound](#run-a-repo-bound-agent) so the guest clones and advertises `repo=`. |
| Claimed but the agent never starts | Guest container failed to boot (`max_instances` reached, clone failed, bad `GIT_TOKEN`) | `npx wrangler containers list`; check `container stopped` lines in `wrangler tail`. The run errors out on Cursor's side after its claim wait. |
| Snapshot miss / slow first boot | No R2 object yet, stale snapshot, or cache not enabled | Expected for [repo-bound](#run-a-repo-bound-agent). Set `WORKER_PUBLIC_URL` + `SNAPSHOT_AUTH_TOKEN` to enable. Unused in any-repo mode. |

## Related resources

- [Cloudflare Containers](https://developers.cloudflare.com/containers/)
- [Cursor Self-Hosted Machines](https://cursor.com/docs/cloud-agent/self-hosted)
- [Cursor Team Pools](https://cursor.com/docs/cloud-agent/self-hosted/pool) ([any-repo pools](https://cursor.com/docs/cloud-agent/self-hosted/pool#any-repo-pools), [pool names](https://cursor.com/docs/cloud-agent/self-hosted/pool#pool-names), [multiple repo roots](https://cursor.com/docs/cloud-agent/self-hosted/pool#register-multiple-repo-roots))
- [`src/controller.ts`](src/controller.ts) — list, SSE watch, claim, spawn
- [`wrangler.jsonc`](wrangler.jsonc) — Worker, cron, Container, Durable Object, and R2 bindings

## License

First-party code in this repository is licensed under the **Apache License, Version 2.0** — see [`LICENSE`](LICENSE).

## Trademarks

This license does not grant permission to use the trade names, trademarks, service marks, or product names of SpaceXAI, Cursor, or Grok, except as required for reasonable and customary use in describing the origin of the Work.

Cloudflare and related marks are trademarks of Cloudflare, Inc. All other trademarks are the property of their respective owners.

## Disclaimer

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
