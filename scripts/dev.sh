#!/usr/bin/env bash
# Local dev: start the Express API (all /api routes) and the Vite dev server,
# which proxies /api + /agent-app to the API and injects the bearer token. Ctrl-C
# stops both. For production, use scripts/serve.sh (Caddy + systemd) instead.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  echo "No .env found — copy .env.example to .env and set VAULT_PATH + DASHBOARD_BEARER_TOKEN." >&2
  exit 1
fi
# Export .env so both the API and Vite's proxy (bearer injection) see it.
set -a; . ./.env; set +a

echo "→ starting Express API on ${API_PORT:-3001}"
( cd api && node --env-file=../.env src/server.mjs ) &
API_PID=$!
trap 'kill "$API_PID" 2>/dev/null || true' EXIT INT TERM

echo "→ starting Vite dev server on 5173 (open http://127.0.0.1:5173)"
cd web && npm run dev
