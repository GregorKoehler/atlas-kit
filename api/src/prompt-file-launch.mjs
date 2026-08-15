/* ------------------------------------------------------------------ *
 * Handing a launch prompt to `claude` WITHOUT putting it in the tmux command —
 * the shell shape, shared by BOTH executors.
 *
 * The box (agent-local.mjs, writing to STATE_DIR) and the bridge
 * (agent-bridge/server.mjs, writing into the container) materialize the file in
 * different places, but the command they build around it must stay identical:
 * this is the one thing that keeps a ~26 KB opening prompt off a command line
 * tmux rejects at ~16 KB, and a copy on each side is exactly the drift this
 * shared module exists to prevent.
 *
 * The prompt goes to a per-session file and the command carries only its PATH:
 * the session's own shell reads it back into a variable — where the limit is
 * ARG_MAX (megabytes), not tmux's ~16 KB — and passes it to claude as one
 * argument. The expansion happens in the shell, BEFORE claude starts, so it
 * costs the agent no turn (making the agent `Read` the file would cost one, and
 * re-introduce the discovery the evidence bundle exists to avoid).
 *
 * Byte-exactness: `"$(cat f)"` inside double quotes is not word-split, not
 * globbed and not re-parsed, so the only transform command substitution applies
 * is stripping TRAILING newlines — which is why promptFileBody strips them on
 * the way to disk too. What claude receives is then byte-identical to the file.
 * (It also removes a latent corruption in the old
 * `cmd.replace('{task}', shquote(prompt))`: a prompt containing `$&` or `$'` was
 * mangled by String.replace's replacement patterns. Hence the function form of
 * the replacement here — do not reintroduce a string one.)
 *
 * `&&` not `;`: if the file is unreadable the launch STOPS instead of starting
 * an agent with an empty prompt. `rm -f` runs after the read, so the file exists
 * only for the moment between the write and the session's shell starting.
 * ------------------------------------------------------------------ */

// POSIX single-quote escaping for the one path this module embeds (each executor
// keeps its own copy for the strings it owns).
function shquote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

// What goes ON DISK: trailing newlines stripped, because `$(cat …)` strips them
// on the way back and the two must agree byte for byte.
export function promptFileBody(prompt) {
  return String(prompt).replace(/\n+$/, '')
}

// The launch command for `sh -lc`: read the prompt file, remove it, then run
// `cmd` with its `{task}` placeholder replaced by the expanded prompt.
export function promptFileCommand(cmd, file) {
  const q = shquote(file)
  return `ATLAS_PROMPT="$(cat ${q})" && rm -f ${q} && ${cmd.replace('{task}', () => '"$ATLAS_PROMPT"')}`
}
