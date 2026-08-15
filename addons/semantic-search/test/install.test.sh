#!/usr/bin/env bash
# The self-heal GUARD CHAIN in install.sh — the half that is dangerous when wrong.
#
# `--heal` runs from cron every five minutes and can start a 1.4 GB download. The
# guards are what keep that safe: opt-out → already installed? → persisted
# exponential backoff → single-flight lock. The failure this file exists to catch
# is a failed install that does NOT record itself: with no state written there is
# no backoff, and a box with no network hammers Hugging Face every five minutes
# forever. `set -e` is DISABLED inside a function called from an `if` condition,
# so that outcome is one missing `|| return 1` away at all times.
#
# NOT covered here, and deliberately: the SUCCESS path, which needs ~1.4 GB of
# real download. What is covered is every path that decides whether that download
# happens at all, plus the failure bookkeeping afterwards.
#
# Hermetic: its own temp dirs, its own cron target, a file:// base URL — no
# network, no /etc, no $HOME.
#
# Run: bash addons/semantic-search/test/install.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL="$HERE/../install.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fails=0
ok()   { echo "  ok   $1"; }
bad()  { echo "  FAIL $1"; fails=$((fails + 1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

# Every run is sandboxed: its own encoder dir, state file, lock and cron target.
run() {
  env ATLAS_EMBED_DIR="$TMP/embed" \
      ATLAS_EMBED_STATE_FILE="$TMP/state" \
      ATLAS_EMBED_LOCK_FILE="$TMP/lock" \
      ATLAS_ADDON_CRON_FILE="$TMP/cron" \
      ATLAS_EMBED_BASE_URL="file://$TMP/mirror" \
      "$@" bash "$INSTALL" "${INSTALL_ARGS[@]}" >"$TMP/out" 2>&1
  echo $?
}

echo "install.sh --check"
INSTALL_ARGS=(--check)
check "not installed → exit 2 (installable)" "$(run)" 2

mkdir -p "$TMP/embed/node_modules/@huggingface/transformers" "$TMP/embed/models/onnx-community/embeddinggemma-300m-ONNX/onnx"
M="$TMP/embed/models/onnx-community/embeddinggemma-300m-ONNX"
echo '{}' > "$M/tokenizer.json"
echo 'graph' > "$M/onnx/model_fp16.onnx"
# `installed()` is STRICTER than the API's runtime check on purpose: a truncated
# weight blob reads as "available" to the API and then fails at the first
# inference, so the heal has to see it as not installed or it can never repair it.
truncate -s 400000000 "$M/onnx/model_fp16.onnx_data"
check "a TRUNCATED weight blob still reads as not installed" "$(run)" 2
truncate -s 600000000 "$M/onnx/model_fp16.onnx_data"
check "complete → exit 0" "$(run)" 0

echo "install.sh --heal"
INSTALL_ARGS=(--heal)
check "already installed → silent no-op" "$(run)" 0
[ -f "$TMP/state" ] && bad "a no-op heal must not write state" || ok "a no-op heal writes no state"

rm -rf "$TMP/embed/models"
check "opt-out (ATLAS_EMBED_AUTOINSTALL=0) → does nothing" "$(run ATLAS_EMBED_AUTOINSTALL=0)" 0
[ -f "$TMP/state" ] && bad "the opt-out must not write state" || ok "the opt-out writes no state"

# A mirror that answers 404 for everything: the install must FAIL, and must
# RECORD that it failed. (config.json exists so the loop gets past its first file.)
mkdir -p "$TMP/mirror"
check "a failing download → exit 1" "$(run)" 1
grep -q '^phase=failed' "$TMP/state" && ok "the failure is recorded (phase=failed)" || bad "no failure recorded — there would be NO BACKOFF"
check "failures counted" "$(grep '^failures=' "$TMP/state" | cut -d= -f2)" 1
grep -q '^last=[0-9]' "$TMP/state" && ok "the failure is timestamped" || bad "no timestamp — the backoff cannot compute a delay"
[ -f "$TMP/cron" ] && bad "a failed install must not wire cron" || ok "a failed install wires no cron"

# …and the very next tick backs off instead of trying again.
check "the next heal backs off rather than retrying" "$(run)" 0
check "the backoff did not advance the counter" "$(grep '^failures=' "$TMP/state" | cut -d= -f2)" 1
grep -q 'backing off' "$TMP/out" && ok "the backoff says why" || bad "the backoff is silent"

# A held lock is the last guard: two sweeps must never download at once.
printf 'failures=1\nlast=0\n' > "$TMP/state"   # long past the 15 min delay → due
( flock 9; check "a heal yields to an install already running" "$(run)" 0 ) 9>"$TMP/lock"
grep -q 'already running' "$TMP/out" && ok "the lock yield says why" || bad "the lock yield is silent"

# Partial downloads never survive as if complete.
find "$TMP/embed" -name '*.part' | grep -q . && bad "a .part file was left behind" || ok "no .part files left behind"

echo
if [ "$fails" = 0 ]; then echo "install.sh guard chain: all checks passed"; else echo "install.sh guard chain: $fails FAILED"; fi
exit $((fails > 0))
