#!/usr/bin/env bash
# Remove what install.sh put on the box. Reversible in the other direction too —
# re-running install.sh puts it all back.
#
# ⚠️ THE VAULT'S INDEX IS NOT TOUCHED BY DEFAULT. `data/atlas-index/` inside the
# vault is ~35 MB of vectors that cost ~90 minutes of CPU to rebuild, and it is
# the vault's own gitignored projection data — this script has no business
# deciding it is disposable. `--purge-index` removes it explicitly.
#
# Disabling the addon is a separate, smaller action: drop `semantic-search` from
# ATLAS_ADDONS / addons.json and restart. That alone makes the kit behave exactly
# as if the addon were never there; this script is for reclaiming the ~1.4 GB.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIR="${ATLAS_EMBED_DIR:-$HOME/.atlas-kit/embed}"
STATE_DIR="${AGENT_LOCAL_DIR:-$HOME/.atlas-kit}"
STATE="${ATLAS_EMBED_STATE_FILE:-$STATE_DIR/semantic-search-install.state}"
CRON="${ATLAS_ADDON_CRON_FILE:-/etc/cron.d/atlas-kit-addons}"

log() { echo "[semantic-search] $*"; }

# The cron file is REGENERATED from the enabled addons rather than edited, so a
# disable-then-regenerate is what actually removes the line. Falls back to a
# plain delete when the generator cannot run (no node, not root).
if [ -w "$(dirname "$CRON")" ] 2>/dev/null; then
  if command -v node >/dev/null 2>&1; then
    ATLAS_ADDONS="" node "$ROOT/scripts/addon-cron.mjs" --install || rm -f "$CRON"
  else
    rm -f "$CRON"
  fi
  log "cron entry removed ($CRON)"
else
  log "cannot write $(dirname "$CRON") — remove $CRON yourself (needs root)"
fi

if [ -d "$DIR" ]; then
  log "removing the out-of-tree encoder → $DIR ($(du -sh "$DIR" 2>/dev/null | cut -f1))"
  rm -rf "$DIR"
else
  log "no encoder at $DIR"
fi

rm -f "$STATE"

if [ "${1:-}" = --purge-index ]; then
  # Resolved through the vault registry rather than guessed, so a multi-vault
  # install removes the right one — and through .env, so it resolves the SAME
  # vault the API does rather than the built-in fallback.
  ENVFILE=()
  [ -f "$ROOT/.env" ] && ENVFILE=(--env-file="$ROOT/.env")
  IDX="$(node "${ENVFILE[@]}" -e '
    import("'"$ROOT"'/api/src/vaults.mjs").then((m) => {
      const v = m.resolveVault(process.env.ATLAS_SEMANTIC_VAULT || undefined)
      process.stdout.write(v ? v.path + "/data/atlas-index" : "")
    })' 2>/dev/null || true)"
  if [ -n "$IDX" ] && [ -d "$IDX" ]; then
    log "removing the vector index → $IDX ($(du -sh "$IDX" 2>/dev/null | cut -f1))"
    rm -rf "$IDX"
  else
    log "no index found to purge"
  fi
else
  log "the vault's data/atlas-index/ was KEPT — pass --purge-index to remove it too"
fi

log "done. Remove \"semantic-search\" from ATLAS_ADDONS / addons.json and restart the API."
