#!/usr/bin/env bash
# Boots one Cursor pool worker inside a Cloudflare container.
#
# Environment (set per-launch by POST /spawn via the CursorPoolWorker DO):
#   CURSOR_API_KEY                     team service-account API key (required)
#   CURSOR_POOL                        pool to register into (required)
#   CURSOR_WORKER_NAME                 worker display name (controller sets this
#                                      to CURSOR_AGENT_WORKER_ID)
#   CURSOR_AGENT_WORKER_ID             stable worker id to register with
#   CURSOR_REPO_URL                    clone URL for --worker-dir (required)
#   CURSOR_API_ENDPOINT                optional agent/bridge URL (from wrangler
#                                      CURSOR_AGENT_ENDPOINT, not the fleet API)
#   CURSOR_WORKER_IDLE_RELEASE_TIMEOUT idle seconds before the worker exits 0
#   GIT_USERNAME / GIT_TOKEN           HTTPS clone credentials (optional)
#   SNAPSHOT_BASE_URL                  Worker snapshot route base (optional)
#   SNAPSHOT_AUTH_TOKEN                bearer token for the snapshot routes
#   SNAPSHOT_MAX_AGE_SECONDS           rebuild snapshots older than this
#   SNAPSHOT_MAX_BYTES                 skip uploading tarballs larger than this
set -euo pipefail

log() { printf '[entrypoint] %s\n' "$*" >&2; }

: "${CURSOR_API_KEY:?CURSOR_API_KEY is required}"
: "${CURSOR_POOL:?CURSOR_POOL is required}"
: "${CURSOR_REPO_URL:?CURSOR_REPO_URL is required}"

SNAPSHOT_MAX_AGE_SECONDS="${SNAPSHOT_MAX_AGE_SECONDS:-604800}"
# Snapshot uploads stream through the Worker, so they are subject to the
# Cloudflare plan's request-body limit (100 MB free / 200 MB paid / 500 MB
# enterprise). Larger repos simply skip the cache and clone every boot.
SNAPSHOT_MAX_BYTES="${SNAPSHOT_MAX_BYTES:-209715200}"
WORKSPACES_DIR="${WORKSPACES_DIR:-$HOME/workspaces}"
export CURSOR_DATA_DIR="${CURSOR_DATA_DIR:-$HOME/.cursor-data}"
export GIT_TERMINAL_PROMPT=0

mkdir -p "$WORKSPACES_DIR" "$CURSOR_DATA_DIR"

# Git credentials are served from the environment by a credential helper so
# tokens never touch disk — and therefore never end up inside snapshots.
if [[ -n "${GIT_TOKEN:-}" ]]; then
  # Single quotes are intentional (SC2016): expansion must happen when git
  # runs the helper, not when it is configured.
  # shellcheck disable=SC2016
  git config --global credential.helper \
    '!f() { echo "username=${GIT_USERNAME:-x-access-token}"; echo "password=${GIT_TOKEN}"; }; f'
fi

snapshot_key() {
  printf '%s' "$1" | sha256sum | awk '{print $1}'
}

snapshot_curl() {
  curl -fsS -H "Authorization: Bearer ${SNAPSHOT_AUTH_TOKEN:-}" "$@"
}

# Restore a repo from the snapshot cache when a fresh-enough snapshot exists;
# otherwise clone it and (best effort) upload a post-clone snapshot so the
# next boot skips the clone.
restore_or_clone() {
  local repo_url="$1" dir="$2"
  local key
  key="$(snapshot_key "$repo_url").tar.gz"

  if [[ -d "$dir/.git" ]]; then
    log "reusing existing checkout at $dir"
    git -C "$dir" fetch --all --prune --quiet || log "fetch failed; keeping stale checkout"
    return 0
  fi

  if [[ -n "${SNAPSHOT_BASE_URL:-}" ]]; then
    local created_at_ms
    created_at_ms="$(snapshot_curl -I "$SNAPSHOT_BASE_URL/$key" 2>/dev/null |
      tr -d '\r' | awk -F': ' 'tolower($1)=="x-snapshot-created-at" {print $2}')" || true
    if [[ -n "${created_at_ms:-}" ]]; then
      local age_seconds=$(( $(date +%s) - created_at_ms / 1000 ))
      if (( age_seconds < SNAPSHOT_MAX_AGE_SECONDS )); then
        log "restoring $repo_url from snapshot (${age_seconds}s old)"
        mkdir -p "$dir"
        if snapshot_curl "$SNAPSHOT_BASE_URL/$key" | tar -xz -C "$dir" &&
           git -C "$dir" fetch --all --prune --quiet; then
          log "snapshot restore complete for $repo_url"
          return 0
        fi
        log "snapshot restore failed; falling back to full clone"
        rm -rf "$dir"
      else
        log "snapshot for $repo_url is stale (${age_seconds}s); recloning"
      fi
    fi
  fi

  log "cloning $repo_url"
  git clone --quiet "$repo_url" "$dir"

  if [[ -n "${SNAPSHOT_BASE_URL:-}" ]]; then
    local tarball
    tarball="$(mktemp /tmp/snapshot-XXXXXX.tar.gz)"
    # The tarball must have a known content length (R2 requires it), so it is
    # staged on disk rather than streamed.
    if tar -czf "$tarball" -C "$dir" .; then
      local size
      size="$(stat -c %s "$tarball")"
      if (( size <= SNAPSHOT_MAX_BYTES )); then
        log "uploading post-clone snapshot ($size bytes)"
        snapshot_curl -X PUT -H "x-snapshot-repo-url: $repo_url" \
          -T "$tarball" "$SNAPSHOT_BASE_URL/$key" >/dev/null ||
          log "snapshot upload failed (continuing without cache)"
      else
        log "snapshot too large to cache ($size > $SNAPSHOT_MAX_BYTES bytes); skipping upload"
      fi
    fi
    rm -f "$tarball"
  fi
}

worker_dir="$WORKSPACES_DIR/repo-0"
restore_or_clone "$CURSOR_REPO_URL" "$worker_dir"

AGENT_BIN="$(command -v agent || command -v cursor-agent || true)"
if [[ -z "$AGENT_BIN" ]]; then
  log "cursor-agent CLI not found on PATH"
  exit 1
fi

log "starting pool worker: pool=$CURSOR_POOL repo=$CURSOR_REPO_URL"
# Pool name, display name, idle-release timeout, worker id, and the API key
# all flow in via their CURSOR_* environment variables, which the CLI reads
# natively. --pool <name> is the non-deprecated form of CURSOR_POOL.
exec "$AGENT_BIN" \
  worker --worker-dir "$worker_dir" --pool "$CURSOR_POOL" \
  start --verbose
