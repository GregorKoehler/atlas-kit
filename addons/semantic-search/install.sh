#!/usr/bin/env bash
# Install the on-box prerequisites for the semantic-search addon
# (EmbeddingGemma-300M over ONNX Runtime). See this directory's README.md.
#
# Installs (idempotent — re-running skips what is already present):
#   - @huggingface/transformers   ONNX Runtime + tokenizers          (~690 MB)
#   - embeddinggemma-300m-ONNX    fp16 weights + tokenizer           (~640 MB)
#   - /etc/cron.d/atlas-kit-addons  the 5-minute sweep (needs root; skipped otherwise)
#
# WHY OUT OF TREE AND NOT IN api/package.json. Every deploy runs `npm ci` when
# the lockfile changes. Putting ~690 MB of ONNX Runtime native binaries on that
# path would tax every future deploy of the whole kit — including the many
# installs that never enable this addon. So the runtime installs ONCE into
# $ATLAS_EMBED_DIR and the addon imports it by absolute path. Until this script
# has run, the semantic leg answers `available: false` with a reason and the
# full-text leg is byte-identical to before: the feature is inert, not broken.
#
# fp16 ONLY, deliberately: it is bit-identical to fp32 in retrieval quality and
# ~580 MB cheaper resident. fp32/q8 are not downloaded.
#
# MODES
#   (no args)  install now. Clears any backoff — an operator asking IS the retry.
#   --check    report the install state WITHOUT downloading anything, so the
#              self-heal never has to re-implement what "installed" means:
#                exit 0 — already installed
#                exit 2 — not installed, and installable right now
#                exit 1 — not installed and cannot be (reason on stderr)
#   --heal     the AUTOMATIC entry point (sweep.sh / cron). Same install, but
#              guarded: opt-out → already installed? → persisted backoff →
#              single-flight lock. Silent and cheap on a healthy box.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIR="${ATLAS_EMBED_DIR:-$HOME/.atlas-kit/embed}"
MODEL_ID="onnx-community/embeddinggemma-300m-ONNX"
M="$DIR/models/$MODEL_ID"
# Overridable so an install behind a Hugging Face mirror (or an air-gapped copy
# of the weights) needs no patch — and so the guard chain below is testable
# without a 1.4 GB download.
BASE="${ATLAS_EMBED_BASE_URL:-https://huggingface.co/$MODEL_ID/resolve/main}"
MIN_AVAIL_MB=3000

STATE_DIR="${AGENT_LOCAL_DIR:-$HOME/.atlas-kit}"
STATE="${ATLAS_EMBED_STATE_FILE:-$STATE_DIR/semantic-search-install.state}"
LOCK="${ATLAS_EMBED_LOCK_FILE:-/tmp/atlas-kit-embed-install.lock}"
BACKOFF_MIN=15        # after the 1st failure…
BACKOFF_CAP_MIN=480   # …doubling to an 8 h ceiling

log() { echo "[semantic-search] $*"; }

# ~1.4 GB installed; refuse early rather than half-way through a 640 MB download.
disk_ok() {
  local parent avail
  parent="$(dirname "$DIR")"
  mkdir -p "$parent" 2>/dev/null || true
  avail=$(df -Pm "$parent" 2>/dev/null | awk 'NR==2 {print $4}')
  if [ -z "$avail" ]; then
    echo "!! cannot read free space for $parent" >&2
    return 1
  fi
  [ "$avail" -ge "$MIN_AVAIL_MB" ] && return 0
  echo "!! only ${avail} MB free — need ~${MIN_AVAIL_MB} MB of headroom for the download + install" >&2
  return 1
}

# ⚠️ STRICTER than the addon's `embedRuntimeAvailable()` (which only checks that
# the two directories exist), on purpose: a half-finished install — a truncated
# weight blob, a missing tokenizer — reads as "available" to the API and then
# fails at the first inference. The self-heal has to see that as "not installed"
# or it can never repair it. Everything here is a stat; nothing touches the network.
installed() {
  [ -d "$DIR/node_modules/@huggingface/transformers" ] || return 1
  [ -s "$M/tokenizer.json" ] || return 1
  [ -s "$M/onnx/model_fp16.onnx" ] || return 1
  local sz
  sz=$(stat -c %s "$M/onnx/model_fp16.onnx_data" 2>/dev/null || echo 0)
  [ "$sz" -ge 500000000 ]
}

# --- self-heal state: one `key=value` line each -----------------------------
# An absent file means "nothing has failed", i.e. go. That fail-OPEN default is
# deliberate: the failure path is what writes the file, so the only way to be
# wrong is to retry once too often, never to give up silently.
state_get() { [ -f "$STATE" ] && grep -E "^$1=" "$STATE" 2>/dev/null | tail -1 | cut -d= -f2- || true; }

state_clear() { rm -f "$STATE"; }

state_running() {
  mkdir -p "$(dirname "$STATE")" 2>/dev/null || true
  printf 'phase=running\nstarted=%s\n' "$(date +%s)" > "$STATE"
}

state_failed() {
  local n; n="$(state_get failures)"; case "${n:-}" in ''|*[!0-9]*) n=0 ;; esac
  mkdir -p "$(dirname "$STATE")" 2>/dev/null || true
  printf 'phase=failed\nfailures=%s\nlast=%s\nreason=%s\n' \
    "$((n + 1))" "$(date +%s)" "$(echo "${1:-}" | tr -d '\n' | cut -c1-200)" > "$STATE"
}

# Persisted exponential backoff — THE guard that keeps a failing install (no
# network, full disk) from becoming a download hammer on a 5-minute timer:
# 15 min after the first failure, doubling to an 8 h ceiling.
backoff_due() {
  local fails last delay=$BACKOFF_MIN
  fails="$(state_get failures)"; last="$(state_get last)"
  case "${fails:-}" in ''|*[!0-9]*) return 0 ;; esac
  case "${last:-}"  in ''|*[!0-9]*) return 0 ;; esac
  while [ "$fails" -gt 1 ] && [ "$delay" -lt "$BACKOFF_CAP_MIN" ]; do
    delay=$((delay * 2)); fails=$((fails - 1))
  done
  [ "$delay" -gt "$BACKOFF_CAP_MIN" ] && delay=$BACKOFF_CAP_MIN
  [ $(( $(date +%s) - last )) -ge $(( delay * 60 )) ]
}

# --- the cron entry ---------------------------------------------------------
# Declared in api/register.mjs and materialised by scripts/addon-cron.mjs, so
# there is exactly one place the schedule is written down. Needs root; a non-root
# install is still a valid install, it just leaves the sweep to the operator.
wire_cron() {
  if [ "$(id -u)" != 0 ]; then
    log "not root — skipping cron. Wire the sweep yourself:"
    log "    sudo ATLAS_ADDONS=semantic-search node $ROOT/scripts/addon-cron.mjs --install"
    return 0
  fi
  ATLAS_ADDONS="${ATLAS_ADDONS:-semantic-search}" node "$ROOT/scripts/addon-cron.mjs" --install
}

# --- the actual install -----------------------------------------------------
# ⚠️ EVERY step checks its own exit status explicitly. `set -e` is DISABLED inside
# a function called from an `if` condition or the left of `||` — which is exactly
# how both call sites below invoke this — so relying on it here would let a failed
# download fall through to "installed", skip `state_failed`, and therefore skip
# the backoff: a failing install would hammer the network every five minutes,
# which is the one outcome the guard chain exists to prevent.
do_install() {
  log "install → $DIR"
  disk_ok || return 1
  mkdir -p "$M/onnx" || return 1

  if [ -d "$DIR/node_modules/@huggingface/transformers" ]; then
    log "transformers.js present"
  else
    log "installing @huggingface/transformers (~690 MB)"
    ( cd "$DIR" && { [ -f package.json ] || npm init -y >/dev/null; } && npm install @huggingface/transformers@4.2.0 ) || {
      echo "!! npm install failed" >&2
      return 1
    }
  fi

  # `model_fp16.onnx` is the graph; `model_fp16.onnx_data` is the external weight
  # file it references BY NAME — one without the other loads and then fails at the
  # first inference, so both are fetched together. Downloaded to `.part` and moved,
  # so a half-file can never be mistaken for a complete one on the next run.
  for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json \
           added_tokens.json generation_config.json \
           onnx/model_fp16.onnx onnx/model_fp16.onnx_data; do
    if [ -s "$M/$f" ]; then
      echo "   have $f"
    else
      echo "   fetching $f"
      if ! curl -fsSL --retry 3 -o "$M/$f.part" "$BASE/$f"; then
        rm -f "$M/$f.part"
        echo "!! failed to fetch $f" >&2
        return 1
      fi
      mv "$M/$f.part" "$M/$f" || return 1
    fi
  done

  # The SAME predicate the self-heal uses, as the final gate — so "install
  # succeeded" and "the heal considers it installed" can never disagree. It
  # catches the ~617 MB weight blob arriving truncated, which would otherwise
  # surface as a confusing ORT error at the first query rather than here.
  if ! installed; then
    echo "!! install finished but $DIR does not look complete — delete it and re-run" >&2
    return 1
  fi
  return 0
}

case "${1:-}" in
  --check)
    installed && { echo "installed: $DIR"; exit 0; }
    disk_ok || exit 1
    echo "not installed: $DIR"
    exit 2
    ;;

  --heal)
    # Cheap by construction: on a healthy box this is one `installed()` (stats
    # only, no network) and a return.
    [ "${ATLAS_EMBED_AUTOINSTALL:-1}" = 0 ] && exit 0
    installed && exit 0
    backoff_due || { log "encoder missing, but backing off after $(state_get failures) failed attempt(s) — see $STATE"; exit 0; }
    # Single-flight: two sweeps must never download at once. `flock -n` so a
    # sweep that finds one running simply leaves.
    exec 8>"$LOCK"
    flock -n 8 || { log "an install is already running — leaving it to finish"; exit 0; }
    state_running
    if do_install; then
      state_clear
      wire_cron || true
      log "encoder installed — the semantic leg is live on the next query"
      exit 0
    fi
    state_failed "install failed; see the sweep log"
    log "encoder install FAILED — backing off"
    exit 1
    ;;

  '' )
    # The operator's entry point. Skips the backoff — asking IS the retry — and
    # is loud rather than silent.
    exec 8>"$LOCK"
    flock -n 8 || { log "an install is already running — skipping"; exit 0; }
    if installed; then
      log "already installed → $DIR"
    else
      state_running
      do_install || { state_failed "manual install failed"; exit 1; }
    fi
    state_clear
    wire_cron
    echo
    log "installed. Size:"
    du -sh "$DIR"
    echo
    echo "Next:"
    echo "  1. enable the addon:  ATLAS_ADDONS=semantic-search  (or addons.json)"
    echo "  2. build the index:   node addons/semantic-search/scripts/index.mjs"
    echo "     (~90 min cold on a ~1.6k-page vault; minutes incrementally thereafter)"
    echo "  3. restart the API:   scripts/serve.sh restart"
    ;;

  *)
    echo "usage: install.sh [--check|--heal]" >&2
    exit 2
    ;;
esac
