#!/usr/bin/env bash
# serve-tmux.test.sh — verify serve.sh's tmux session lifecycle WITHOUT touching the
# live `api` session or binding any real ports. Sources serve.sh (the dispatch is
# guarded, so nothing runs), points it at a throwaway socket via ATLAS_TMUX_SOCKET,
# overrides SESSION, and drives ensure_session()/svc() with a stub command.
#
# Regression target: the 2026-06-28 deploy 502. The old stop() ran `tmux kill-session`;
# when `api` was the only session that tore down the whole server and raced the next
# new-session. The fix keeps the server alive via a keepalive window and respawns
# service windows in place. These tests pin both properties.
set -uo pipefail

SOCKET="atlas-kit-selftest-$$"
export ATLAS_TMUX_SOCKET="$SOCKET"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/serve.sh"
SESSION="selftest"   # never the real `api`

cleanup() { command tmux -L "$SOCKET" kill-server 2>/dev/null || true; }
trap cleanup EXIT

fail=0
ok()   { printf '  ok   — %s\n' "$1"; }
bad()  { printf '  FAIL — %s\n' "$1"; fail=1; }
check(){ if eval "$2"; then ok "$1"; else bad "$1 [expr: $2]"; fi; }

win_count() { tmux list-windows -t "$SESSION" -F '#W' 2>/dev/null | grep -c "^$1\$"; }
pane_pid()  { tmux list-panes   -t "$SESSION:$1" -F '#{pane_pid}' 2>/dev/null | head -1; }

echo "== ensure_session creates a keepalive-backed session =="
ensure_session
check "session exists"                 'tmux has-session -t "$SESSION" 2>/dev/null'
check "keepalive window present"        '[ "$(win_count "$KEEPALIVE")" = 1 ]'

echo "== ensure_session is idempotent =="
ensure_session
check "still exactly one keepalive win" '[ "$(win_count "$KEEPALIVE")" = 1 ]'

echo "== transition: a pre-existing keepalive-less session gets one (first deploy) =="
# Simulate the running session from the OLD serve.sh: a session with only a service
# window and NO keepalive. ensure_session must add the keepalive BEFORE stop() could
# empty the session — otherwise the first deploy of this fix would 502 like the bug.
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -n express 'sleep 1000' 9>&-
check "precondition: no keepalive yet"  '[ "$(win_count "$KEEPALIVE")" = 0 ]'
ensure_session
check "keepalive added to old session"  '[ "$(win_count "$KEEPALIVE")" = 1 ]'
check "service window left intact"       '[ "$(win_count express)" = 1 ]'

echo "== transition RACE: graft fails + server vanishes → recover via fresh session =="
# The 2026-06-29 deploy 502: ensure_session attached a keepalive to the OLD keepalive-
# less session, but that server was collapsing — the new-window failed AND the server
# was gone, yet ensure_session returned success → stop()+svc then hit "no server" and
# nothing came up. Reproduce deterministically: a keepalive-less session exists, but the
# FIRST keepalive new-window fails and takes the server down with it (server vanished
# under us). ensure_session must NOT trust that, and must converge to a fresh session.
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -n express 'sleep 1000' 9>&-
_race_armed=1
tmux() {                       # shadow serve.sh's wrapper for this scenario only
  if [ "${_race_armed:-0}" = 1 ] && [ "${1:-}" = new-window ]; then
    case " $* " in *" $KEEPALIVE "*)
      _race_armed=0
      command tmux "${TMUX_ARGS[@]}" kill-server 2>/dev/null  # server vanishes mid-graft
      return 1 ;;
    esac
  fi
  command tmux "${TMUX_ARGS[@]}" "$@"
}
ensure_session
rc=$?
tmux() { command tmux "${TMUX_ARGS[@]}" "$@"; }   # restore serve.sh's real wrapper
check "ensure_session converges (rc=0)" '[ "$rc" = 0 ]'
check "fresh session exists"            'tmux has-session -t "$SESSION" 2>/dev/null'
check "keepalive present after recovery" '[ "$(win_count "$KEEPALIVE")" = 1 ]'

echo "== svc creates a service window =="
svc demo "sleep 1000"; sleep 0.2
check "demo window created"             '[ "$(win_count demo)" = 1 ]'
pid1="$(pane_pid demo)"
check "demo has a live pane pid"        '[ -n "$pid1" ]'

echo "== svc respawns IN PLACE (no duplicate window, process replaced) =="
svc demo "sleep 1000"; sleep 0.2
check "still exactly one demo window"   '[ "$(win_count demo)" = 1 ]'
pid2="$(pane_pid demo)"
check "pane pid changed (respawned)"    '[ -n "$pid2" ] && [ "$pid1" != "$pid2" ]'

echo "== no-teardown invariant: losing all service windows keeps the server alive =="
tmux kill-window -t "$SESSION:demo" 2>/dev/null || true; sleep 0.2
check "demo window gone"                '[ "$(win_count demo)" = 0 ]'
check "session SURVIVES (no race)"      'tmux has-session -t "$SESSION" 2>/dev/null'

echo "== recovery: svc re-creates the window after it was lost =="
svc demo "sleep 1000"; sleep 0.2
check "demo window recreated"           '[ "$(win_count demo)" = 1 ]'

echo
if [ "$fail" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; fi
exit "$fail"
