#!/usr/bin/env bash
# Spawn hook for `agent worker controller --spawn ./spawn.sh`.
#
# The controller claims a pending private-worker request, then execs this
# script with CURSOR_* in the environment. We ask Cloudflare to start one
# guest container and return — do not wait for cursor-agent to finish.
#
# Exit codes (CLI contract):
#   0  spawned (or already running)
#   1  retryable (network, 5xx, 429, …)
#   2+ fatal (bad config, 4xx)
set -euo pipefail

log() { printf '[spawn] %s\n' "$*" >&2; }

if [[ -z "${CLOUDFLARE_WORKER_URL:-}" ]]; then
  log "CLOUDFLARE_WORKER_URL is required (deployed Worker URL, no trailing slash needed)"
  exit 2
fi
if [[ -z "${CLOUDFLARE_SPAWN_TOKEN:-}" ]]; then
  log "CLOUDFLARE_SPAWN_TOKEN is required (same value as the Worker's SPAWN_TOKEN secret)"
  exit 2
fi
if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  log "CURSOR_API_KEY is missing; the controller should inject it"
  exit 2
fi
if [[ -z "${CURSOR_POOL:-}" ]]; then
  log "CURSOR_POOL is missing; the controller should inject it from the claimed request"
  exit 2
fi

encode_payload() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json, os; print(json.dumps({k: v for k, v in os.environ.items() if k.startswith("CURSOR_")}))'
    return
  fi
  if command -v node >/dev/null 2>&1; then
    node -e 'const o={}; for (const [k,v] of Object.entries(process.env)) if (k.startsWith("CURSOR_") && v) o[k]=v; process.stdout.write(JSON.stringify(o))'
    return
  fi
  log "need python3 or node to encode the spawn JSON body"
  exit 2
}

payload="$(encode_payload)"
url="${CLOUDFLARE_WORKER_URL%/}/spawn"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

http_code="$(
  curl -sS -o "$tmp" -w '%{http_code}' \
    --connect-timeout 10 --max-time 60 \
    -X POST "$url" \
    -H "Authorization: Bearer ${CLOUDFLARE_SPAWN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$payload"
)" || {
  log "request to $url failed"
  exit 1
}

body="$(cat "$tmp" 2>/dev/null || true)"
log "POST /spawn -> ${http_code} ${body}"

case "$http_code" in
  2*) exit 0 ;;
  408|409|425|429|5*) exit 1 ;;
  *) exit 2 ;;
esac
