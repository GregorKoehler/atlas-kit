/* Native cross-session messaging policy for Atlas Kit-SPAWNED sessions.
 *
 * Claude Code ≥ 2.1.224 gives every session a `ListAgents`/`SendMessage` pair
 * and a per-session Unix inbox socket, ON BY DEFAULT: any session running as the
 * same OS user can mail any other, so every agent tmux session on the box is an
 * addressable peer. That is a second, unsanctioned message channel beside the
 * kit's agent bus (`agent-msg`, docs/PROTOCOLS.md) — no lineage bound, no
 * per-pair budget, no `agent-messages.jsonl` audit line, no attribution/trust
 * header, and nothing the dashboard can show. The bus stays the only sanctioned
 * channel, so the native one is closed at spawn time.
 *
 * ONE implementation, imported by BOTH executors (api/src/agent-local.mjs and
 * agent-bridge/server.mjs) — a copy would drift, and a box-only deploy would
 * leave every bridge on the old policy.
 *
 * Per session kind:
 *   dev       — refuse inbound AND deny both tools. A dev agent's peer mail goes
 *               through `agent-msg`/the bus; it has no sanctioned native use.
 *   knowledge — refuse inbound ONLY. Refusing INBOUND closes the uncontrolled
 *               entry point; an orchestrator's outbound native send is visible
 *               in its own transcript, and the tools are load-bearing there (see
 *               the cost below).
 *
 * ⚠️ KNOWN COST of the dev denies: `SendMessage` is ONE tool serving BOTH
 * cross-session mail and continuing an in-process subagent by id. So a dev agent
 * can still SPAWN read-only sub-agents — the `Agent` tool is untouched — but can
 * no longer send a follow-up to one it already spawned. That is the accepted
 * trade for closing the channel; it is also exactly why knowledge/Atlas chats
 * (which orchestrate) keep both tools.
 *
 * Delivered through `claude --settings <json>`, which loads ADDITIONAL settings:
 * it composes with the user/project settings the session already reads rather
 * than replacing them (deny rules UNION across scopes), and unknown keys are
 * ignored silently, so a bridge machine still on a pre-2.1.224 Claude Code
 * launches unchanged rather than failing. A denied tool is absent from the
 * session EVEN WITH `--dangerously-skip-permissions` — that flag skips
 * permission PROMPTS, not deny-rule evaluation, which is what makes the denies
 * worth anything here.
 *
 * ⚠️ If the inbox socket is ever adopted as a delivery channel for steers,
 * `refuse` is the thing to revisit — turn the policy off with
 * ATLAS_NATIVE_MSG_POLICY=off while that is decided.
 *
 * Tests: api/test/native-msg-policy.test.mjs.
 */

// Kill-switch, read per PROCESS — so a bridge machine can be reverted without
// touching the box, and vice versa. Off ⇒ inject nothing at all, i.e. a
// byte-identical launch to before this.
export function nativeMsgPolicyOn(env = process.env) {
  return !/^(0|false|no|off)$/i.test(env.ATLAS_NATIVE_MSG_POLICY || '')
}

// The settings object a session of this kind launches with.
export function nativeMsgSettings(kind) {
  if (kind !== 'dev' && kind !== 'knowledge') throw new Error(`native-msg-policy: unknown kind ${kind}`)
  const settings = { crossSessionInbound: 'refuse' }
  if (kind === 'dev') settings.permissions = { deny: ['SendMessage', 'ListAgents'] }
  return settings
}

// POSIX single-quote escaping — the launch templates are `sh -lc` strings.
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"

// The `claude` command word: bare (`claude`, the bridge), or the tail of a path,
// shell-quoted or not (`'/home/u/.local/bin/claude'`, the box — claude-bin.mjs).
// It may follow a `{claudeEnv}` placeholder directly, with no space between.
const CLAUDE_WORD = /(^|[\s}/'])claude('?)(?=\s)/

/* Fold the policy into a launch/resume template, right after the `claude` word
 * so it survives every template variant (--resume, --session-id, --mcp-config)
 * and any AGENT_*_LAUNCH_CMD override that still invokes claude. A template that
 * already passes `--settings` is left ALONE: an operator override is the more
 * specific instruction, and a second flag would clobber it.
 */
export function withNativeMsgPolicy(cmd, kind, env = process.env) {
  const settings = nativeMsgSettings(kind) // validate the kind even when off
  if (!nativeMsgPolicyOn(env)) return cmd
  if (/(^|\s)--settings[\s=]/.test(cmd)) return cmd
  const flag = `--settings ${shq(JSON.stringify(settings))}`
  return cmd.replace(CLAUDE_WORD, (m, lead, quote) => `${lead}claude${quote} ${flag}`)
}
