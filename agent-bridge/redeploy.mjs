/* ------------------------------------------------------------------ *
 * Pure helpers for the phone-triggered "Redeploy bridge" button
 * (agent-bridge/server.mjs's redeploy()). Split into their own
 * side-effect-free module so the systemd-run argv construction and the
 * unit-collision detection can be unit-tested without booting the whole
 * bridge (which needs BRIDGE_TOKEN, docker, tmux, ... just to import).
 * See server.mjs's redeploy() for why systemd-run is load-bearing here.
 * ------------------------------------------------------------------ */

// POSIX single-quote escaping — safe to embed in a `sh -lc` string. Mirrors
// server.mjs's own shquote (duplicated, not imported, to keep this module
// free of any of server.mjs's side effects).
function shquote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

// The systemd-run argv that launches restart-agent-bridge.sh as a transient
// unit OUTSIDE this process's own cgroup. Only forwards the two env vars the
// script actually reads (REDEPLOY_STATE_FILE, BRIDGE_PULL_USER — see the
// script's header) — not the bridge's whole environment, which holds
// BRIDGE_TOKEN and has no reason to be exposed on a unit's properties
// (`systemctl show` is readable by non-root).
export function buildRedeploySystemdRunArgs({ unit, stateFile, pullUser, script, log, cwd }) {
  const setenv = [`--setenv=REDEPLOY_STATE_FILE=${stateFile}`]
  if (pullUser) setenv.push(`--setenv=BRIDGE_PULL_USER=${pullUser}`)
  return [
    '--collect', // unload the unit (success or fail) so the fixed name is free for the next redeploy
    `--unit=${unit}`,
    '--property=Type=oneshot',
    '--no-block', // don't wait for the script to finish — just confirm the unit started
    `--working-directory=${cwd}`,
    ...setenv,
    '--',
    'bash', '-lc', `exec ${shquote(script)} >>${shquote(log)} 2>&1`,
  ]
}

// systemd-run fails synchronously (even under --no-block) when a unit of the
// same fixed name is still loaded/active — confirmed live: "Failed to start
// transient service unit: Unit <name> was already loaded or has a fragment
// file." Map that one case to the same 409 the state-file staleness check
// uses; anything else is a genuine failure.
export function isUnitCollisionError(e) {
  return /already (loaded|exists|active)/i.test(String(e?.stderr || e?.message || ''))
}
