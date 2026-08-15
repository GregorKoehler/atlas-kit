#!/usr/bin/env bash
# ------------------------------------------------------------------ #
# Redeploy / bounce the Atlas Kit agent-bridge on the WORKSTATION.
#
# Companion to install-agent-bridge.sh (which does first-time setup). Use THIS
# to pick up new bridge code after it lands on the default branch, or just to
# restart the service. Re-runnable, idempotent. Also the ONE THING POST /redeploy
# on the bridge itself runs (agent-bridge/server.mjs — the dashboard's
# phone-triggered "Redeploy bridge" button): launched there via a transient
# systemd-run unit so it survives `systemctl restart` killing the very bridge
# process that started it.
#
#   sudo scripts/restart-agent-bridge.sh             # git pull --ff-only → restart → health check
#   sudo scripts/restart-agent-bridge.sh --no-pull   # just restart (e.g. after editing repos.json)
#
# (sudo is needed for `systemctl restart`; the pull + health check don't need it.)
#
# Env (both optional):
#   BRIDGE_PULL_USER     whose gh/git auth to pull with when running as ROOT
#                        with no SUDO_USER set — i.e. the bridge's own
#                        POST /redeploy path, which runs this script directly
#                        (no `sudo`, so no SUDO_USER, and root has no gh auth
#                        of its own). Set it in agent-bridge/bridge.env.
#                        Ignored when SUDO_USER IS set (the interactive `sudo`
#                        path keeps using that real user, unchanged).
#   REDEPLOY_STATE_FILE  when set, phase transitions (pull/restart/health,
#                        then done or error) are written here as JSON so
#                        GET /redeploy-status can surface them — set by the
#                        bridge's POST /redeploy; unset (the interactive path)
#                        → a no-op, terminal output only.
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
sha() { git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?'; }

# Optional phase-state file (see header) — a no-op unless REDEPLOY_STATE_FILE is
# set. The box's GET /api/agents/bridge-status polls it back through the bridge,
# so a redeploy triggered from a phone can render its phase.
STATE="${REDEPLOY_STATE_FILE:-}"
state() {
  [ -n "$STATE" ] || return 0
  printf '{"phase":"%s","step":"%s","sha":"%s","at":"%s"}\n' "$1" "$2" "$(sha)" "$(date -u +%FT%TZ)" > "$STATE"
}

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
# only `systemctl restart` below actually needs root. Four cases, in priority
# order: root+SUDO_USER (the interactive `sudo` path) → that user; root with
# BRIDGE_PULL_USER (the bridge's own POST /redeploy, which has no SUDO_USER) →
# that user; root with neither → refuse loudly, since root has no gh auth and the
# pull would silently fail or hang; non-root → just pull as ourselves.
git_pull() {
  local g=(git -C "$ROOT")
  command -v gh >/dev/null 2>&1 && g+=(-c "credential.helper=!gh auth git-credential")
  if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
    sudo -H -u "$SUDO_USER" env GIT_TERMINAL_PROMPT=0 "${g[@]}" pull --ff-only
  elif [ "$(id -u)" -eq 0 ] && [ -n "${BRIDGE_PULL_USER:-}" ]; then
    sudo -H -u "$BRIDGE_PULL_USER" env GIT_TERMINAL_PROMPT=0 "${g[@]}" pull --ff-only
  elif [ "$(id -u)" -eq 0 ]; then
    state error pull
    die "running as root with neither SUDO_USER nor BRIDGE_PULL_USER set — can't pull with a real user's gh auth.
  set BRIDGE_PULL_USER=<your-user> in $ENV_FILE (see this script's header), or run interactively via 'sudo scripts/restart-agent-bridge.sh' as your user."
  else
    GIT_TERMINAL_PROMPT=0 "${g[@]}" pull --ff-only
  fi
}
if [ "$PULL" -eq 1 ]; then
  before="$(sha)"
  state deploying pull
  say "pulling latest in $ROOT …"
  git_pull || { state error pull; die "git pull --ff-only failed — authentication, or a diverged/dirty tree.
  • auth:  run 'gh auth login' (or 'gh auth setup-git') as your user, then re-run.
  • tree:  'git -C $ROOT status' and resolve, then re-run.
  • or skip the pull entirely: scripts/restart-agent-bridge.sh --no-pull"; }
  after="$(sha)"
  [ "$before" = "$after" ] && say "already up to date ($after)." || say "updated $before → $after."
else
  say "--no-pull: restarting current checkout ($(sha))."
fi

# --- 2. restart the systemd service -------------------------------------------
state deploying restart
if systemctl cat "$SERVICE" >/dev/null 2>&1; then
  say "restarting service: $SERVICE"
  $SUDO systemctl restart "$SERVICE" || { state error restart; die "systemctl restart $SERVICE failed — check: journalctl -u $SERVICE -n 50"; }
else
  state error restart
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
state deploying health
say "waiting for health on http://$HOST:$PORT/health …"
ok=0
for _ in $(seq 1 20); do
  if curl -fsS "http://$HOST:$PORT/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 0.3
done
if [ "$ok" -eq 1 ]; then
  state done ok
  say "✅ bridge healthy ($(sha)): $(curl -fsS "http://$HOST:$PORT/health")"
else
  state error health
  die "bridge did NOT come up healthy on http://$HOST:$PORT/health — check: journalctl -u $SERVICE -n 50"
fi

# --- 4. control-plane priority check (advisory) -------------------------------
# Nice/CPUWeight/OOMScoreAdjust are what keep the bridge answering on a box
# saturated by its own tenants. They live in the UNIT, which
# install-agent-bridge.sh writes and this script never touches — so a box whose
# unit predates them redeploys perfectly and stays unprotected.
# Say which it is; a silent no-op here is exactly how this regresses.
# Advisory only: never fail a redeploy that otherwise worked.
num() { [[ "${1:-}" =~ ^-?[0-9]+$ ]]; }
props="$(systemctl show "$SERVICE" -p Nice -p CPUWeight -p OOMScoreAdjust 2>/dev/null || true)"
nice="$(printf '%s\n' "$props" | sed -n 's/^Nice=//p' | tail -n1)"
weight="$(printf '%s\n' "$props" | sed -n 's/^CPUWeight=//p' | tail -n1)"
oom="$(printf '%s\n' "$props" | sed -n 's/^OOMScoreAdjust=//p' | tail -n1)"
bad=''
num "$nice"   && [ "$nice" -le -5 ]     || bad="$bad Nice=${nice:-?}(want<=-5)"
num "$weight" && [ "$weight" -ge 1000 ] || bad="$bad CPUWeight=${weight:-?}(want>=1000)"
num "$oom"    && [ "$oom" -le -500 ]    || bad="$bad OOMScoreAdjust=${oom:-?}(want<=-500)"
if [ -z "$bad" ]; then
  say "✅ control-plane priority in effect: Nice=$nice CPUWeight=$weight OOMScoreAdjust=$oom"
elif [ -z "$props" ]; then
  say "⚠ could not read the unit's priority properties (systemctl show returned nothing) — check by hand:"
  say "    systemctl show $SERVICE -p Nice -p CPUWeight -p OOMScoreAdjust"
else
  say "⚠ control-plane priority NOT in effect —$bad"
  say "  This unit predates the priority settings; a restart alone never adds them."
  say "  Fix (idempotent, rewrites the unit and applies it):  sudo scripts/install-agent-bridge.sh"
  say "  Why it matters: a saturated box can starve the bridge that manages it."
fi
