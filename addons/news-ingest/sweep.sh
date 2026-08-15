#!/usr/bin/env bash
# The hourly sweep — what the addon's cron entry runs (see api/register.mjs).
#
# One `node` process, no self-heal step: this addon has no out-of-tree runtime to
# repair. Everything it needs is node, git and the `claude` CLI, and each missing
# one is a loud, recorded failure rather than something a script should silently
# reinstall on a timer.
#
# --env-file so the sweep sees VAULT_PATH, the feed caps and the model exactly as
# the API does. An absent .env is not fatal: the vault registry falls back to
# VAULT_PATH from the environment.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [ -f "$ROOT/.env" ]; then
  exec node --env-file="$ROOT/.env" addons/news-ingest/scripts/sweep.mjs "$@"
fi
exec node addons/news-ingest/scripts/sweep.mjs "$@"
