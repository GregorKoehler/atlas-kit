#!/usr/bin/env bash
# ------------------------------------------------------------------ #
# Redeploy / bounce the Atlas Kit agent-bridge on the WORKSTATION.
#
# Companion to install-agent-bridge.sh (which does first-time setup). Use THIS
# to pick up new bridge code after it lands on master, or just to restart the
# service. Re-runnable, idempotent.
#
#   sudo scripts/restart-agent-bridge.sh             # git pull --ff-only → restart → health check
#   sudo scripts/restart-agent-bridge.sh --no-pull   # just restart (e.g. after editing repos.json)
#
# (sudo is needed for `systemctl restart`; the pull + health check don't need it.)
# ------------------------------------------------------------------ #
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_DIR="$ROOT/agent-bridge"
ENV_FILE="$BRIDGE_DIR/bridge.env"
SERVICE="atlas-kit-agent-bridge"

PULL=1
[ "${1:-}" = "--no-pull" ] && PULL=0

say() { printf '\033[36m[agent-bridge]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[agent-bridge] %s\033[0m\n' "$*" >&2; exit 1; }

SUDO=''
[ "$(id -u)" -ne 0 ] && SUDO=sudo

# --- 1. pull latest code (fast-forward only) ----------------------------------
# repos.json + bridge.env are gitignored, so a pull never conflicts with local
# config. --ff-only refuses to merge a diverged/dirty tree (fails loud, not silent).
sha() { git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?'; }
# Pull WITHOUT prompting: use the GitHub CLI's token for HTTPS when gh is present
# (GitHub dropped password auth), and never block on an interactive credential
# prompt (GIT_TERMINAL_PROMPT=0 → fail loud instead). When the script is run via
# `sudo`, run the pull as the REAL user so it uses THEIR gh/git auth, not root's —
# only `systemctl restart` below actually needs root.
git_pull() {
  local g=(git -C "$ROOT")
  command -v gh >/dev/null 2>&1 && g+=(-c "credential.helper=!gh auth git-credential")
  if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
    sudo -H -u "$SUDO_USER" env GIT_TERMINAL_PROMPT=0 "${g[@]}" pull --ff-only
  else
    GIT_TERMINAL_PROMPT=0 "${g[@]}" pull --ff-only
  fi
}
if [ "$PULL" -eq 1 ]; then
  before="$(sha)"
  say "pulling latest in $ROOT …"
  git_pull || die "git pull --ff-only failed — authentication, or a diverged/dirty tree.
  • auth:  run 'gh auth login' (or 'gh auth setup-git') as your user, then re-run.
  • tree:  'git -C $ROOT status' and resolve, then re-run.
  • or skip the pull entirely: scripts/restart-agent-bridge.sh --no-pull"
  after="$(sha)"
  [ "$before" = "$after" ] && say "already up to date ($after)." || say "updated $before → $after."
else
  say "--no-pull: restarting current checkout ($(sha))."
fi

# --- 2. restart the systemd service -------------------------------------------
if systemctl cat "$SERVICE" >/dev/null 2>&1; then
  say "restarting service: $SERVICE"
  $SUDO systemctl restart "$SERVICE"
else
  die "systemd unit '$SERVICE' not found — run scripts/install-agent-bridge.sh first, or start it manually:
  ( set -a; . '$ENV_FILE'; set +a; node '$BRIDGE_DIR/server.mjs' )"
fi

# --- 3. health check ----------------------------------------------------------
# The bridge binds BRIDGE_HOST (the tailnet IP), so check that, not loopback.
HOST=127.0.0.1; PORT=7878
if [ -f "$ENV_FILE" ]; then
  H="$(sed -n 's/^BRIDGE_HOST=//p' "$ENV_FILE" | tail -n1)"; [ -n "$H" ] && HOST="$H"
  P="$(sed -n 's/^BRIDGE_PORT=//p' "$ENV_FILE" | tail -n1)"; [ -n "$P" ] && PORT="$P"
fi
say "waiting for health on http://$HOST:$PORT/health …"
ok=0
for _ in $(seq 1 20); do
  if curl -fsS "http://$HOST:$PORT/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 0.3
done
if [ "$ok" -eq 1 ]; then
  say "✅ bridge healthy ($(sha)): $(curl -fsS "http://$HOST:$PORT/health")"
else
  die "bridge did NOT come up healthy on http://$HOST:$PORT/health — check: journalctl -u $SERVICE -n 50"
fi
