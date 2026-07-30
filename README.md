# Cursor pool workers on Cloudflare Containers

Template for running [Cursor self-hosted pool workers](https://cursor.com/docs)
inside Cloudflare's infrastructure. One deployment of this Cloudflare Worker
schedules containers for any number of Cursor worker pools:

- **You supply** a Cursor team **service-account API key**, a list of **pool
  names**, and (optionally) the **repos** each pool broadcasts.
- **The Worker** polls Cursor's fleet API for pending agent runs
  (`GET /v0/private-workers/pending-requests`) and claims matching work by
  waking a container that boots `cursor-agent worker start --pool`.
- **Everything scales to zero.** Pools are durable rows on the Cursor side
  (they stay selectable in the composer at zero connected workers), the
  scheduler runs on cheap Durable Object alarms, and containers stop as soon
  as their worker process exits.
- **Post-clone snapshots** of each repo are cached in R2, so container boots
  restore a tarball and `git fetch` instead of paying a full clone.

```
                 Cursor (api.cursor.com)
                    ▲                ▲
      pending-requests poll          │ bridge connection (claim, agent loop)
                    │                │
┌───────────────────┼────────────────┼──────────────────────────────┐
│ Cloudflare        │                │                              │
│  ┌────────────────┴───┐   ┌────────┴─────────────────────┐        │
│  │ PoolScheduler (DO) │──▶│ CursorPoolWorker (container) │ x N    │
│  │ alarm loop, claims │   │ entrypoint.sh:               │        │
│  └───────┬────────────┘   │  restore-or-clone repos      │        │
│          │ snapshots      │  run cursor-agent worker     │        │
│          ▼                └────────▲─────────────────────┘        │
│  ┌────────────────┐  GET/PUT tarballs                             │
│  │ R2 bucket      │◀───────────────┘                              │
│  └────────────────┘                                               │
└───────────────────────────────────────────────────────────────────┘
```

## How scheduling works

1. A user (or the API) starts a cloud agent targeting one of your pools. The
   run appears in `GET /v0/private-workers/pending-requests` until a worker
   picks it up.
2. The `PoolScheduler` Durable Object polls that endpoint every
   `POLL_INTERVAL_SECONDS` on a Durable Object alarm. Each pending request is
   matched against the configured pools by its `pool` label (absent label =
   pool `default`) and, for repo-pinned pools, its repository.
3. For each matched request the scheduler wakes a free container slot
   (`pool=<name>/slot=<n>`). Cooldowns ensure one request never fans out into
   multiple containers, and a request that failed to boot a worker is retried
   after the cooldown.
4. The container clones (or snapshot-restores) the pool's repos and execs
   `cursor-agent worker start --pool`. The moment that worker connects, the
   **Cursor backend performs the authoritative claim** — the request drops out
   of the pending list and the agent run executes on the container.
5. When the run finishes and the idle-release timeout
   (`WORKER_IDLE_RELEASE_TIMEOUT_SECONDS`) passes without follow-up work, the
   worker process exits with code 0, the container stops, and the slot is free
   again. Zero pending work = zero running containers.

A `* * * * *` cron trigger re-arms the alarm loop if it ever gets lost; the
alarm itself does the sub-minute polling.

## Prerequisites

- A Cursor **team plan** with private/self-hosted workers enabled for the
  team, and a **service-account API key** (Dashboard → Settings → Service
  Accounts) with agent scope. Pool workers reject personal API keys.
- A Cloudflare account with **Workers Paid** (Containers and Durable Objects
  are not available on the free plan) and **R2** enabled.
- Node 20+ and Docker locally (wrangler builds the container image on deploy).

## Setup

1. Clone this repo and install dependencies:

   ```bash
   git clone git@github.com:anysphere/cloudflare-workers.git
   cd cloudflare-workers
   npm install
   ```

2. Create the snapshot bucket (name must match `wrangler.jsonc`):

   ```bash
   npx wrangler r2 bucket create cursor-pool-worker-snapshots
   ```

3. Configure your pools in `wrangler.jsonc` → `vars.POOLS`, a JSON array:

   ```json
   [
     { "name": "default", "repos": ["https://github.com/acme/payments"] },
     { "name": "big-ci", "repos": ["https://github.com/acme/payments", "https://github.com/acme/infra"], "maxWorkers": 5 },
     { "name": "anything" }
   ]
   ```

   - Every worker launched for a pool clones **all** of the pool's repos and
     broadcasts them: the pool becomes selectable in the composer for each
     listed repo, even at zero running containers.
   - A pool with **no repos** serves any repository: its workers clone
     whatever repo the pending request references. Such pools only become
     discoverable per-repo after serving work, because current cursor-agent
     releases require every worker dir to be a git checkout (see
     [Limitations](#limitations)).

4. Set secrets:

   ```bash
   npx wrangler secret put CURSOR_API_KEY        # required: service-account key
   npx wrangler secret put GIT_USERNAME          # optional: e.g. x-access-token
   npx wrangler secret put GIT_TOKEN             # optional: PAT for private repos
   npx wrangler secret put ADMIN_TOKEN           # optional: enables /status, /tick
   npx wrangler secret put SNAPSHOT_AUTH_TOKEN   # optional: defaults to CURSOR_API_KEY
   ```

   Git credentials are handed to containers as environment variables and
   served to git through an in-memory credential helper — they are never
   written to disk and never end up inside snapshots.

5. Set `vars.WORKER_PUBLIC_URL` in `wrangler.jsonc` to the URL your Worker
   will have (e.g. `https://cursor-pool-workers.<account>.workers.dev`). This
   enables the snapshot cache; without it every boot does a full clone.

6. Deploy:

   ```bash
   npx wrangler deploy
   ```

   On the first scheduler tick, each pool with repos gets a one-off
   **broadcast boot**: a short-lived worker registers the pool's durable rows
   with Cursor so the pool shows up in the composer immediately. Re-broadcast
   happens automatically whenever a pool's repo list changes.

7. Start an agent from [cursor.com/agents](https://cursor.com/agents) (or the
   API), pick a repo the pool broadcasts, and select **Self-Hosted Pools →
   <your pool>**. Watch containers come and go with
   `npx wrangler containers list` or via `GET /status`.

## Configuration reference

| Var | Default | Meaning |
|---|---|---|
| `POOLS` | `[{"name":"default","repos":[]}]` | Pools this deployment serves (JSON; `name`, `repos`, optional `maxWorkers`) |
| `MAX_WORKERS_PER_POOL` | `3` | Container slots per pool unless overridden per pool |
| `WORKER_IDLE_RELEASE_TIMEOUT_SECONDS` | `300` | Idle seconds before a worker exits and its container stops |
| `POLL_INTERVAL_SECONDS` | `20` | Pending-request poll cadence |
| `SNAPSHOT_MAX_AGE_SECONDS` | `604800` (7d) | Snapshots older than this are rebuilt from a fresh clone |
| `WORKER_PUBLIC_URL` | unset | Public URL of this Worker; enables the snapshot cache |
| `MAX_RUN_LIFETIME_SECONDS` | `28800` (8h) | Hard ceiling on one container's lifetime |
| `CURSOR_API_URL` | `https://api.cursor.com` | Fleet-management API base |
| `CURSOR_AGENT_ENDPOINT` | `https://api2.cursor.sh` | Endpoint the in-container CLI connects to |

Keep `containers[].max_instances` in `wrangler.jsonc` at least as large as
the sum of `maxWorkers` across pools, plus one for broadcast boots.

## Admin API

With the `ADMIN_TOKEN` secret set (`Authorization: Bearer <token>`):

- `GET /status` — pool config, last tick summary, per-slot container state.
- `POST /tick` — run a scheduling pass immediately.
- `POST /slots/<pool>/<slot>/stop` — force-stop one container slot.

`GET /health` is public and unauthenticated.

## Snapshotting (skip the clone on boot)

Container filesystems are ephemeral, so a naive setup pays a full `git clone`
of every repo on every boot. The template caches **post-clone snapshots**:

1. On first boot for a repo, the entrypoint clones it, then tars the checkout
   and `PUT`s it to the Worker's `/internal/snapshots/<sha256(clone-url)>.tar.gz`
   route, which stores it in R2.
2. Subsequent boots `HEAD` the snapshot; if it exists and is younger than
   `SNAPSHOT_MAX_AGE_SECONDS`, they download and unpack it and run an
   incremental `git fetch` instead of a clone.
3. Stale snapshots are rebuilt from a fresh clone (which also refreshes the
   cache), so the incremental fetch never drifts too far from origin.

Notes:

- Snapshot uploads stream through the Worker and are subject to Cloudflare's
  request-body limit (100 MB free / 200 MB paid / 500 MB enterprise; the
  entrypoint's `SNAPSHOT_MAX_BYTES` guard defaults to 200 MB). Repos above the
  limit skip the cache and clone every boot — swap the routes for presigned R2
  URLs if you need multi-GB snapshots.
- Snapshots contain only the git checkout. Credentials are injected at runtime
  via a credential helper and are never part of the tarball.
- The snapshot routes require `Authorization: Bearer <SNAPSHOT_AUTH_TOKEN>`
  (defaulting to the API key), so only your containers can read or write them.

## Limitations

- **One pool per worker process.** A container registers into exactly one
  pool per boot (`--pool-name` takes a single value); the scheduler decides
  per pending request which pool a container serves. One *deployment* handles
  any number of pools.
- **Repo-less workers are not currently possible.** Released cursor-agent
  builds require each `--worker-dir` to be a git clone with an origin remote,
  so pending requests without a repository are skipped, and any-repo pools
  cannot broadcast themselves before serving their first request.
- **CLI version is baked at image build.** `wrangler deploy` rebuilds the
  image with the latest CLI; redeploy periodically to pick up updates.
- **The scheduler is best-effort, the backend is authoritative.** If two
  deployments serve the same pool, both may boot workers for a request; the
  Cursor backend claims exactly one and the other idles out harmlessly.

## Development

```bash
npm test                       # unit tests for planning/matching/config
npx tsc --noEmit               # typecheck
npx wrangler deploy --dry-run  # validate config + build the container image
shellcheck container/entrypoint.sh
```

The scheduling logic (`src/matching.ts`, `src/config.ts`) is dependency-free
and unit-tested; the Durable Objects (`src/scheduler.ts`, `src/container.ts`)
are thin shells around it.
