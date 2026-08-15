#!/usr/bin/env bash
# The five-minute sweep — what the addon's cron entry runs (see api/register.mjs).
#
# Two steps, in this order and for this reason:
#   1. SELF-HEAL. The encoder lives out of tree so it stays off every `npm ci`,
#      which also means no deploy ever puts it back — and its loss is SILENT:
#      search keeps answering with the full-text leg alone. `install.sh --heal`
#      is the guarded, backoff-limited, single-flighted repair. On a healthy box
#      it is a handful of stat() calls.
#   2. SWEEP. Re-index only what changed. A no-op sweep is ~0.33 s and writes
#      ~150 bytes; it exits 0 immediately when the encoder is still missing, so
#      step 1 failing does not make this noisy.
#
# ⚠️ The heal must NOT abort the sweep. A box that cannot reinstall right now
# (no network, no disk) usually still has a usable index, and skipping the sweep
# would make the index look stale on the scorecard for a reason that has nothing
# to do with the index. Hence `|| true`.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

bash addons/semantic-search/install.sh --heal || true

# --env-file so the sweep sees VAULT_PATH / ATLAS_SEMANTIC_VAULT exactly as the
# API does. Absent .env is not fatal: the vault registry falls back to VAULT_PATH
# from the environment.
if [ -f "$ROOT/.env" ]; then
  exec node --env-file="$ROOT/.env" addons/semantic-search/scripts/index.mjs "$@"
fi
exec node addons/semantic-search/scripts/index.mjs "$@"
