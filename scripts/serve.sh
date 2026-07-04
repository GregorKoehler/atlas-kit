#!/usr/bin/env bash
# serve.sh — bring up (and keep up) the dashboard backend: Express API + Caddy.
#
# Why a script instead of a Dockerfile/compose change: recreating the container
# wipes Claude Code's auth (/root/.claude is in the writable layer, not a mount),
# so we never rebuild just to run services. This starts them in a detached tmux
# session, loading secrets from .env at runtime.
#
# Persistence across `docker restart` / host reboot (no rebuild): `install-boot`
# drops a /etc/profile.d hook. The image CMD is a login shell (`bash -lc`), which
# sources /etc/profile.d/*.sh on every container start — so the hook re-runs this
# (backgrounded, idempotent) and the services come back up. The profile.d file
# lives in the writable layer (survives restart; wiped only on a full recreate —
# re-run `serve.sh install-boot` if that ever happens).
#
# Usage: serve.sh [ensure|restart|stop|status|install-boot]
set -uo pipefail

# Non-interactive launches (systemd atlas-kit.service) inherit no $HOME, so git can't
# find /root/.gitconfig — losing both the commit identity and the gh credential
# helper. An agent's vault commit/push then hangs on a "Username for
# github.com" prompt. Default HOME so git auth works in the spawned workers.
export HOME="${HOME:-/root}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION=api
KEEPALIVE=_keepalive          # holder window — keeps the session (and tmux server) alive
HEALTH=http://127.0.0.1:8080/api/health
HOOK=/etc/profile.d/zz-atlas-kit-serve.sh

# All tmux calls go through this wrapper so an optional dedicated socket can be used
# for isolation/tests (ATLAS_TMUX_SOCKET); empty → the default socket (production,
# unchanged). The real binary is reached via `command tmux` so this never recurses.
TMUX_ARGS=()
[ -n "${ATLAS_TMUX_SOCKET:-}" ] && TMUX_ARGS=(-L "$ATLAS_TMUX_SOCKET")
tmux() { command tmux "${TMUX_ARGS[@]}" "$@"; }

log() { echo "[serve] $*"; }
is_up() { curl -fsS --max-time 2 "$HEALTH" >/dev/null 2>&1; }

stop() {
  # Stop the service processes but DO NOT kill the tmux session — tearing it down
  # raced the next start when `api` was the only session (→ Cloudflare 502; see
  # ensure_session). start() respawns the windows in place; the keepalive window
  # holds the server open. These pkills still mop up any orphan OUTSIDE a tmux window
  # (e.g. a caddy left holding :8080 after a botched run); caddy ignores SIGHUP so it
  # must be killed by exact cmdline.
  pkill -f "caddy run --config $ROOT/infra/Caddyfile" 2>/dev/null || true
  pkill -f "node --env-file=.env api/src/server.mjs" 2>/dev/null || true
  pkill -f "node --env-file=.env api/src/mcp/http.mjs" 2>/dev/null || true
}

# Keep the tmux session — and therefore the server — alive across restarts via a
# persistent keepalive window, instead of tearing the session down. The old stop()
# ran `tmux kill-session`; when `api` was the lone session that killed the whole
# server, and the immediately-following `new-session` raced its async shutdown
# ("server exited unexpectedly") → no panes, Express/Caddy down → Cloudflare 502.
# A live keepalive window means kill-session is never needed, so the race is gone.
ensure_session() {
  for _ in 1 2 3 4 5; do
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      # Session exists — guarantee the keepalive holder is present. It may predate
      # this code (the running session from the OLD serve.sh has none) or have been
      # closed; without it, stop() closing the last service window would empty the
      # session and tear the server down — the very race this fixes. Creating it here,
      # BEFORE stop() runs, keeps the server alive through the restart.
      tmux list-windows -t "$SESSION" -F '#W' 2>/dev/null | grep -qx "$KEEPALIVE" && return 0
      # Add the holder, and CONFIRM it took. A failed add means the server vanished
      # under us — the old keepalive-less session was collapsing exactly as we attached
      # (the first-deploy transition off the OLD serve.sh). Don't trust a half-done
      # graft (returning 0 here is what 502'd the 2026-06-29 deploy): fall through, and
      # the next pass sees no session and recreates a fresh one from scratch.
      if tmux new-window -t "$SESSION" -n "$KEEPALIVE" 'while :; do sleep 86400; done' 9>&- 2>/dev/null \
         && tmux list-windows -t "$SESSION" -F '#W' 2>/dev/null | grep -qx "$KEEPALIVE"; then
        return 0
      fi
    else
      # No server/session — create one. 9>&- : this new-session STARTS the tmux server,
      # which must not inherit fd 9 (the single-flight flock from start()) or it holds
      # the lock forever and makes every later restart no-op on `flock -n 9` (the
      # 2026-06-26 stuck-lock bug). Confirm the session exists before trusting it.
      if tmux new-session -d -s "$SESSION" -n "$KEEPALIVE" 'while :; do sleep 86400; done' 9>&- 2>/dev/null \
         && tmux has-session -t "$SESSION" 2>/dev/null; then
        return 0
      fi
    fi
    sleep 0.3   # let a mid-exit server finish; the next pass recreates from scratch
  done
  log "could not establish tmux '$SESSION' session with keepalive"; return 1
}

# (Re)start one service window IN PLACE. respawn-window -k SIGKILLs the old process
# before relaunching (so `caddy run`, which ignores SIGHUP, is actually replaced) — no
# session teardown needed for a clean slate. The first-run new-window closes fd 9 for
# the same reason as ensure_session; respawn-window can't start a server so it needn't.
svc() {
  local name="$1" cmd="$2"
  if tmux list-windows -t "$SESSION" -F '#W' 2>/dev/null | grep -qx "$name"; then
    tmux respawn-window -k -t "$SESSION:$name" "$cmd"
  else
    tmux new-window -t "$SESSION" -n "$name" "$cmd" 9>&-
  fi
}

start() {
  # Single-flight: if another start is in progress (e.g. two login shells at
  # boot), skip rather than racing the tmux session.
  exec 9>/tmp/atlas-kit-serve.lock
  flock -n 9 || { log "another start in progress; skipping"; return 0; }

  type -P tmux     >/dev/null || { log "tmux not found";  return 1; }
  command -v caddy >/dev/null || { log "caddy not found"; return 1; }
  [ -f "$ROOT/.env" ] || { log "missing $ROOT/.env"; return 1; }

  if [ ! -f "$ROOT/web/dist/index.html" ]; then
    log "building web/dist…"
    ( cd "$ROOT/web" && npm run build ) || { log "build failed"; return 1; }
  fi

  ensure_session || return 1
  stop
  # Strip any inherited ANTHROPIC_API_KEY so the spawned `claude -p` workers use
  # the subscription, not API-key billing (a host key leaks in via compose). HOME is
  # set explicitly on each worker command (not just exported above): the tmux server
  # may predate our HOME, and new panes inherit the SERVER's env — without it the
  # agent's git auth fails. svc() (re)starts each window in place; see its
  # comment and ensure_session for the fd-9 / no-teardown rationale.
  svc express \
    "cd '$ROOT' && HOME='$HOME' env -u ANTHROPIC_API_KEY node --env-file=.env api/src/server.mjs 2>&1 | tee /tmp/atlas-kit-express.log"
  svc caddy \
    "set -a; . '$ROOT/.env'; set +a; caddy run --config '$ROOT/infra/Caddyfile' 2>&1 | tee /tmp/atlas-kit-caddy.log"
  # MCP server (streamable-HTTP, 127.0.0.1:3002). Localhost-only; the remote
  # connector exposure (Cloudflare Tunnel → mcp.<domain>, behind Access) is wired
  # separately once the Access app exists. Cf-Access JWT check is a no-op until
  # CF_ACCESS_* are set in .env.
  svc mcp \
    "cd '$ROOT' && HOME='$HOME' env -u ANTHROPIC_API_KEY node --env-file=.env api/src/mcp/http.mjs 2>&1 | tee /tmp/atlas-kit-mcp.log"

  for _ in $(seq 1 30); do
    is_up && { log "up: Express :3001 + Caddy :8080 (tmux '$SESSION')"; return 0; }
    sleep 0.5
  done
  log "WARNING: health check failed — see /tmp/atlas-kit-express.log and /tmp/atlas-kit-caddy.log"
  return 1
}

install_boot() {
  cat > "$HOOK" <<EOF
# Auto-start the Atlas Kit dashboard backend at container boot. The image CMD is a
# login shell (bash -lc) which sources /etc/profile.d/*.sh, so this runs on every
# container start. Fully backgrounded + idempotent so it never blocks/breaks shells.
[ -x "$ROOT/scripts/serve.sh" ] && ( setsid "$ROOT/scripts/serve.sh" ensure >/tmp/atlas-kit-serve-boot.log 2>&1 & ) 2>/dev/null
true
EOF
  chmod +x "$HOOK"
  log "installed boot hook → $HOOK"

  # Data-refresh cron (also writable-layer, so re-installed here on every recreate).
  install -m 644 "$ROOT/infra/atlas-kit.cron" /etc/cron.d/atlas-kit
  log "installed cron → /etc/cron.d/atlas-kit"
  log "(writable layer — re-run 'serve.sh install-boot' after any container recreate)"
}

# Dispatch only when executed, not when sourced (tests source the functions above).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  case "${1:-restart}" in
    ensure)       is_up && { log "already up"; exit 0; }; start ;;
    restart)      start ;;
    # Explicit full stop: also drop the session/keepalive (safe — nothing restarts
    # right after, so there's no new-session to race the server's shutdown).
    stop)         stop; tmux kill-session -t "$SESSION" 2>/dev/null || true; log "stopped" ;;
    status)       is_up && log "UP" || log "DOWN"; tmux ls 2>/dev/null | grep -E "^${SESSION}:" || true ;;
    install-boot) install_boot ;;
    *) echo "usage: serve.sh [ensure|restart|stop|status|install-boot]"; exit 2 ;;
  esac
fi
