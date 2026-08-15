/* The CHAT's half of outbound agent-control calls — an Atlas orchestrator
 * instructing a dev agent (see agent-history.mjs's `outbound`, which carries the
 * byte-exact instruction the API used to drop).
 *
 * Pure and self-contained on purpose: web has no component-test framework, so
 * the collapse/expand DECISION — the thing that must never make text
 * unreachable — lives here and is unit-tested with `node --test`
 * (outbound.test.mjs), and the component is a thin consumer of it.
 */

export type OutboundKind = 'prompt' | 'queue' | 'interrupt' | 'spawn' | 'ship' | 'kill' | 'cleanup'

/** One outbound agent-control call, as agent-history.mjs records it. */
export interface OutboundCall {
  kind: OutboundKind
  /** The recipient's session id. Absent on a spawn (no session exists yet). */
  target?: string
  /** Only on a spawn — the repo the new agent was started on. */
  repo?: string
  /** The orchestrator's OWN authored instruction, byte-exact. Absent when the
   * words are composed server-side (ship/kill/cleanup) or none were sent. */
  text?: string
  /** The text hit the per-message cap and was cut. */
  truncated?: boolean
}

/** Header line naming WHO received it — the chat's whole complaint was that the
 * recipient was the only thing visible and the message was not. */
export function outboundHeader(o: OutboundCall): string {
  const who = o.kind === 'spawn' ? o.repo || 'a new agent' : o.target || 'an agent'
  const verb = {
    prompt: 'sent to',
    queue: 'queued for',
    interrupt: 'interrupted',
    spawn: 'spawned on',
    ship: 'ship →',
    kill: 'closed',
    cleanup: 'cleaned up',
  }[o.kind]
  return `↪ ${verb} ${who}`
}

/** The honest caveat under the header, or '' when the text needs none.
 *
 * Two cases, and neither may be papered over: a spawn's `task` argument is only
 * the LAST section of the ~30-50 KB prompt the agent actually receives, and the
 * server-composed kinds put fixed template wording into the session that this
 * renderer has no argument for and does not try to reconstruct. */
export function outboundNote(o: OutboundCall): string {
  if (o.kind === 'spawn') return 'task section — the dashboard prepends the standing preambles and an Atlas evidence block'
  if (o.text) return ''
  if (o.kind === 'ship') return 'the canonical ship instruction — composed by the dashboard, not written here'
  if (o.kind === 'kill' || o.kind === 'cleanup') return 'the session recap prompt — composed by the dashboard, not written here'
  if (o.kind === 'interrupt') return 'stopped its turn — no message was sent with it'
  return 'no message text recorded'
}

export interface Collapsed {
  /** The opening of the text, verbatim (never reflowed). */
  preview: string
  /** The complete text, byte-identical to the input — the expander's payload. */
  full: string
  /** The preview is short of the full text, so an expander must be offered. */
  hasMore: boolean
  /** Line count of the full text, for the toggle's label. */
  totalLines: number
}

/** Split a brief into an opening preview and the full text.
 *
 * The complaint is INVISIBILITY, not brevity: `full` is always the untouched
 * input, so nothing is ever unreachable — `preview` only decides how much shows
 * before the operator expands. Bounded by lines AND characters, since a brief
 * with no line breaks would otherwise "fit" the line budget whole. */
export function collapseText(text: string, maxLines = 8, maxChars = 700): Collapsed {
  const lines = text.split('\n')
  let preview = lines.length > maxLines ? lines.slice(0, maxLines).join('\n') : text
  if (preview.length > maxChars) preview = preview.slice(0, maxChars)
  return { preview, full: text, hasMore: preview.length < text.length, totalLines: lines.length }
}
