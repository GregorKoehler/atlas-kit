/* ------------------------------------------------------------------ *
 * WHO put this user turn in the chat — the render-side classification.
 *
 * Every injected message (an Atlas steer, peer mail, a fleet note, a reply
 * receipt, a turn-end line) lands in Claude Code's `.jsonl` as an ORDINARY user
 * turn, byte-indistinguishable from what the operator typed. Two things mark
 * them apart, and this module reads BOTH:
 *
 *   1. `source` — 'atlas' | 'agent' | 'system', recovered server-side by matching
 *      a fingerprint recorded at send time (agent-history.mjs `tagSteered`).
 *      Authoritative, and it holds in practice: a turn carrying a dashboard
 *      attribution header still has its fingerprint. It is not, however,
 *      unconditional — the steer set lives on the SESSION RECORD, capped at
 *      the last 60 entries
 *      (`STEER_KEYS_MAX`) and started fresh by a respawn, while the stitched
 *      transcript keeps every older turn of the conversation.
 *   2. The ATTRIBUTION HEADER the message itself opens with (agent-routes.mjs
 *      `messageHeader`) — delivered TEXT, so it is bounded by nothing and
 *      survives the two cases above. Used as the fallback, and it agrees with
 *      the fingerprint on every message where both exist.
 *
 * What neither carries is the harness's OWN envelopes — `<task-notification>`,
 * `<command-name>`, `<local-command-stdout>` — because the dashboard never sent
 * them: nobody typed those either, and they — together with the launch briefs —
 * were the bulk of what used to render in the operator's own colour.
 *
 * ⚠️ The default direction is AWAY from the operator's style, mirroring
 * queue-delivery.mjs's unknown-fails-safe: a `source` this build does not know
 * is still an INJECTION, so it renders muted rather than as the operator. Only a
 * plain user turn with no marker at all is the operator.
 *
 * Pure (no preact) so it is unit-tested off the card that uses it — see
 * msgProvenance.test.mjs.
 * ------------------------------------------------------------------ */

/** operator: the operator typed it (the ONLY class in the operator colour).
 *  steered:  an Atlas orchestrator injected it (gold — the lineage hue).
 *  peer:     mail from another agent on the message bus (teal).
 *  system:   a machine observation — fleet note, reply receipt, turn-end line,
 *            or a harness notification. Muted: weakest voice in the room.
 *  brief:    the LAUNCH prompt — standing preamble + retrieved Atlas evidence +
 *            the task. Machine-composed around the operator's words, so it is
 *            not a typed message either. */
export type MsgProvenance = 'operator' | 'steered' | 'peer' | 'system' | 'brief'

/** The attribution headers `messageHeader()` writes, anchored at the start of the
 *  delivered text (header line, blank line, body — `withHeader`). */
const HDR_SYSTEM = /^⚙ \*\*Automatic fleet update/
const HDR_ATLAS = /^↪ \*\*From your Atlas orchestrator/
const HDR_PEER = /^↪ \*\*From (?:dev|knowledge) agent/
/** Claude Code's own injected envelopes: a finished background task, a slash
 *  command echo, its stdout. Machine text in a user turn.
 *
 *  ⚠️ Anchored at the START of the message on purpose. An operator message that
 *  merely QUOTES one of these tags mid-text ("the chat shows a raw
 *  `<command-name>`…" — the very report that produced this file) is the
 *  operator's own writing and keeps the operator colour. Only a message that IS
 *  the envelope moves. */
const HARNESS = /^<(?:task-notification|command-name|command-message|command-args|local-command-stdout)>/
/** …and the stdout envelope's tail, which the transcript sometimes carries
 *  without its opening tag (observed after `/compact`). Anchored to
 *  the END for the same reason the rest is anchored to the start. */
const HARNESS_TAIL = /<\/local-command-stdout>"?$/

/** The body markers each system-derived note opens with, after the shared `⚙`
 *  header — so a reply receipt is LABELLED a reply receipt instead of reusing
 *  the fleet-note caption (they are different observations). */
const BODY_LABELS: Array<[RegExp, string]> = [
  [/💬 Reply receipt/, '💬 reply receipt'],
  [/⏸ Turn ended/, '⏸ turn ended'],
  [/[🚀✅] Fleet update/, '⚙ automatic fleet update'],
]

/** Caption for a system-derived turn: name the specific observation where its
 *  own text says which one it is, and stay generic (never wrong) otherwise. */
function systemLabel(text: string): string {
  const head = text.slice(0, 600)
  for (const [re, label] of BODY_LABELS) if (re.test(head)) return label
  if (/^<task-notification>/.test(text)) return '🔔 background task finished'
  if (HARNESS.test(text) || HARNESS_TAIL.test(text)) return '⌨ command output'
  return '⚙ automatic update from the dashboard'
}

export interface MsgOrigin {
  /** Which bubble style this turn gets. */
  provenance: MsgProvenance
  /** The caption above the bubble — empty for an operator turn (no caption). */
  label: string
}

const OPERATOR: MsgOrigin = { provenance: 'operator', label: '' }

/**
 * Classify ONE user turn. `launch` marks the session's opening prompt (the
 * first message of an untruncated history), which is the brief.
 *
 * Assistant turns never reach this — they have their own bubble.
 */
export function msgOrigin(
  m: { text?: string; source?: string | null },
  launch = false,
): MsgOrigin {
  const text = (m.text || '').trim()
  // The recorded source wins when we have one — it was taken at SEND time.
  if (m.source === 'atlas') return { provenance: 'steered', label: '↪ steered by Atlas' }
  if (m.source === 'agent') return { provenance: 'peer', label: '✉ message from another agent' }
  if (m.source === 'system') return { provenance: 'system', label: systemLabel(text) }
  // A source this build doesn't know is still an injection — muted, and it says
  // what it was so an unrecognized provenance is visible rather than silent.
  if (m.source) return { provenance: 'system', label: `⚙ injected message (${m.source})` }
  // No fingerprint survived: read the attribution header the message carries.
  if (HDR_SYSTEM.test(text)) return { provenance: 'system', label: systemLabel(text) }
  if (HDR_ATLAS.test(text)) return { provenance: 'steered', label: '↪ steered by Atlas' }
  if (HDR_PEER.test(text)) return { provenance: 'peer', label: '✉ message from another agent' }
  if (HARNESS.test(text) || HARNESS_TAIL.test(text)) return { provenance: 'system', label: systemLabel(text) }
  if (launch) return { provenance: 'brief', label: '📚 launch brief — preamble + Atlas evidence + the task' }
  return OPERATOR
}

/* --- local slash commands -------------------------------------------- *
 * A slash command the operator ran in the TUI (`/compact`, `/goal …`) is
 * recorded as TWO user turns of raw markup — the invocation
 * (`<command-name>` + `<command-message>` + `<command-args>`) and, separately,
 * its output (`<local-command-stdout>`). The chat view rendered both verbatim,
 * tags included, in the operator's own bubble colour.
 *
 * This takes the envelope APART so the card can draw it as what it is. It never
 * summarizes: `args` and `stdout` come out byte-identical to what is inside the
 * tags, minus the ANSI colour codes the TUI wrote into stdout (`ESC[2m…`),
 * which are display noise no browser renders.
 * -------------------------------------------------------------------- */

export interface LocalCommand {
  /** The command, e.g. `/compact`. Empty when only its output was recorded (the
   *  two halves are separate turns, and either can appear alone). */
  name: string
  /** Its argument text, verbatim — often the operator's own prose (`/goal …`). */
  args: string
  /** The command's output, verbatim minus ANSI colour codes. */
  stdout: string
}

const ANSI = /\u001b\[[0-9;]*m/g
const tagOf = (text: string, tag: string): string => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)
  return m ? m[1].trim() : ''
}

/** Parse a harness command envelope, or null if this message isn't one.
 *  Same anchoring rule as the classifier above — a message merely quoting the
 *  tags is not an envelope and is left completely alone. */
export function parseLocalCommand(text: string): LocalCommand | null {
  const t = (text || '').trim()
  if (!HARNESS.test(t) && !HARNESS_TAIL.test(t)) return null
  const name = tagOf(t, 'command-name')
  const args = tagOf(t, 'command-args')
  // The stdout half can arrive WITHOUT its opening tag (observed in practice), so
  // fall back to "everything before the closing tag" rather than dropping it.
  const closed = t.indexOf('</local-command-stdout>')
  const stdout = (tagOf(t, 'local-command-stdout') || (closed >= 0 ? t.slice(0, closed).trim() : '')).replace(ANSI, '')
  if (!name && !args && !stdout) return null // a bare/unknown envelope — leave the text as it is
  return { name, args, stdout }
}
