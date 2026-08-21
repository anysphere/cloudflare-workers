# Cursor pool workers on Cloudflare Containers

Template for running [Cursor self-hosted pool workers](https://cursor.com/docs)
inside Cloudflare Containers. This repo only **spawns** a container. Poll,
claim, and pool matching live in the agent CLI:

```bash
agent worker controller --spawn ./spawn.sh --pool <name>
```

(`cursor-agent worker controller` is the same binary.) Each spawn starts one
container that runs `cursor-agent worker start --pool` as a long-lived outbound
bridge.

```
  agent worker controller --spawn ./spawn.sh --pool <name>
            │
            │ exec spawn.sh  (CURSOR_* in env)
            ▼
     POST /spawn  ──▶  CursorPoolWorker container
                       entrypoint: clone CURSOR_REPO_URL
                       then `cursor-agent worker start --pool`
```

`--pool` is required unless you pass `--all-pools`. Repeat `--pool` to watch
more than one name.

If `agent worker controller` is missing, install the lab CLI (prod
`cursor.com/install` may still be too old):

```bash
curl https://cursor.com/install?channel=lab -fsS | bash
```

## Prerequisites

- A Cursor **team plan** with private/self-hosted workers enabled, and a
  **service-account API key** (Dashboard → Settings → Service Accounts) with
  agent scope. Pool workers reject personal API keys.
- A Cloudflare account with **Workers Paid** (Containers and R2) and Node 20+
  plus Docker locally (wrangler builds the image on deploy).

## 1. Stand up Cloudflare

```bash
git clone git@github.com:anysphere/cloudflare-workers.git
cd cloudflare-workers
npm install
npx wrangler r2 bucket create cursor-pool-worker-snapshots
```

Set secrets:

```bash
npx wrangler secret put SPAWN_TOKEN          # required: bearer for POST /spawn
npx wrangler secret put GIT_USERNAME         # optional: e.g. x-access-token
npx wrangler secret put GIT_TOKEN            # optional: PAT for private repos
npx wrangler secret put SNAPSHOT_AUTH_TOKEN  # optional: defaults to SPAWN_TOKEN
```

In `wrangler.jsonc`, set `vars.WORKER_PUBLIC_URL` to the URL this Worker will
have (e.g. `https://cursor-pool-workers.<account>.workers.dev`) so container
boots can use the snapshot cache. Then:

```bash
npx wrangler deploy
```

Git credentials are injected into containers at runtime via an in-memory
credential helper — they are never written to disk and never end up inside
snapshots.

## 2. Run the controller

On a machine that can reach the deployed Worker (laptop, bastion, or another
Worker host):

```bash
export CURSOR_API_KEY=...                    # same service-account key
export CLOUDFLARE_WORKER_URL=https://cursor-pool-workers.<account>.workers.dev
export CLOUDFLARE_SPAWN_TOKEN=...            # same value as SPAWN_TOKEN

chmod +x spawn.sh
agent worker controller --spawn ./spawn.sh --api-key "$CURSOR_API_KEY" --pool <name>
```

The controller injects `CURSOR_REQUEST_ID`, `CURSOR_BC_ID`, `CURSOR_REPO_URL`,
`CURSOR_REPO_OWNER`, `CURSOR_REPO_NAME`, `CURSOR_USER_ID`, `CURSOR_POOL`,
`CURSOR_WORKER_NAME`, `CURSOR_API_URL` / `CURSOR_API_ENDPOINT`,
`CURSOR_API_KEY`, and `CURSOR_AGENT_WORKER_ID`. `spawn.sh` forwards those to
`POST /spawn` and returns as soon as Cloudflare accepts the start — it does
not wait for `cursor-agent`.

Exit codes from the hook: **0** spawned, **1** retryable, **2+** fatal.

Then start an agent from [cursor.com/agents](https://cursor.com/agents), pick
the repo, and select **Self-Hosted Pools → \<your pool\>**. Watch containers
with `npx wrangler containers list`.

## Configuration reference

| Var | Default | Meaning |
|---|---|---|
| `CURSOR_AGENT_ENDPOINT` | `https://api2.cursor.sh` | Agent/bridge URL inside the container |
| `WORKER_IDLE_RELEASE_TIMEOUT_SECONDS` | `300` | Idle seconds before a claimed worker exits |
| `SNAPSHOT_MAX_AGE_SECONDS` | `604800` (7d) | Snapshots older than this are rebuilt |
| `WORKER_PUBLIC_URL` | unset | Public URL of this Worker; enables the snapshot cache |
| `MAX_RUN_LIFETIME_SECONDS` | `28800` (8h) | Hard ceiling on one container's lifetime |

Keep `containers[].max_instances` in `wrangler.jsonc` at least as large as the
number of concurrent claimed runs you expect.

`GET /health` is public. `POST /spawn` and `POST /stop` require
`Authorization: Bearer <SPAWN_TOKEN>`.

## Snapshotting

Container filesystems are ephemeral. The template caches **post-clone
snapshots** in R2:

1. First boot clones `CURSOR_REPO_URL`, tars the checkout, and `PUT`s it to
   `/internal/snapshots/<sha256(clone-url)>.tar.gz`.
2. Later boots `HEAD` the snapshot; if it is younger than
   `SNAPSHOT_MAX_AGE_SECONDS`, they unpack it and `git fetch`.

Uploads stream through the Worker and are subject to Cloudflare's request-body
limit (100 MB free / 200 MB paid / 500 MB enterprise). Larger repos skip the
cache. Snapshots contain only the git checkout, not credentials.

## Limitations

- **One pool per worker process.** `--pool` takes a single name per container.
  Run one controller (or several `--pool` flags) for the pools you serve.
- **A git checkout is required.** `cursor-agent` needs `--worker-dir` to be a
  clone with an origin remote, so requests without `CURSOR_REPO_URL` are
  rejected by `spawn.sh`.
- **CLI version is baked at image build.** Redeploy periodically to pick up
  updates.

## Development

```bash
npm test                       # unit tests
npx tsc --noEmit               # typecheck
npx wrangler deploy --dry-run  # validate config + build the container image
shellcheck spawn.sh container/entrypoint.sh
```
