/* ------------------------------------------------------------------ *
 * Reply receipts + turn-end observations — the PURE core (no IO), so it is
 * unit-testable without a live tmux (the same split as queue-delivery.mjs /
 * atlas-ship-notify.mjs).
 *
 * An Atlas chat could send an agent it spawned a message and never learn that it
 * had ANSWERED. Fleet notes (ship-state notes) carry SHIP state only, and
 * 'ready'/'shipped'/'merged' are terminal and latched — so a child finishing an
 * ORDINARY turn was invisible by construction, and the operator had to be the
 * relay between the operator's own agents. This is that missing signal. Two lines come out
 * of one edge detector:
 *
 *   'reply-receipt' — the child finished the turn that consumed a message the
 *                     parent (or the operator) sent it. One per message.
 *   'turn-end'      — the child finished a turn nobody was waiting on a reply
 *                     for, and is now sitting at the prompt. One per turn.
 *
 * ⚠️ KEYED TO THE PARENT'S MESSAGE, NEVER TO THE CHILD'S STATE. That is the
 * whole risk of this feature, and the one thing here not to "simplify" into
 * looking like its neighbour. 'ready'/'merged' are TERMINAL, so the ship notes'
 * once-per-(child, state) latch is safe for them; 'idle' RECURS after every
 * single turn, so the same latch here would re-fire for the rest of the child's
 * life and reproduce a notification flood. Instead:
 *
 *   ARM   — the parent messaged a child it spawned (armReceipt, at the routes).
 *   DELIVER — the parked message has left the child's queue (observed here).
 *   FIRE  — once, on that child's run→wait PHASE EDGE. An edge, not the idle
 *           state: the state is true on every tick, the transition happens once.
 *   SPEND — immediately, in the same pass that fires. No further receipts until
 *           the parent messages again.
 *
 * So: one message + ten idles = ONE receipt; three messages before one idle
 * collapse into ONE. The 'turn-end' line is bounded by the same edge (a turn end
 * happens once per turn) plus MAX_TURN_NOTES_PER_CHILD as a runaway breaker.
 *
 * 🔴 WHY THE PHASE AND NOT `status` (three timestamped reproductions on
 * two hosts). This used to read the RAW per-tick `status`, i.e.
 * `isBusy(pane)` — a pane heuristic that goes momentarily false while a turn is
 * very much still running, and that DELIVERING A MESSAGE reliably trips: the
 * "esc to interrupt" marker lives in Claude Code's bottom footer line, which is
 * rendered to the pane width and ellipsized (measured at 79 of 80 columns, the
 * marker at cols 50-66), so any extra footer segment truncates it away. Every
 * receipt therefore fired ~4.4 s after its own delivery, announcing a turn that
 * then ran another 35 minutes. `agent-timings.mjs` already solved this for the
 * run/wait clock — AGENT_PHASE_DEBOUNCE_MS (7 s) + the interrupt phaseHold — and
 * its history log correctly shows NO turn ending at any of the three moments a
 * receipt claimed one. So we consume `phase`, the debounced signal, which both
 * executors' rosters already carry (box-local publicView; remote mirrored from
 * the shadows by trackRemotePhases' PHASE_FIELDS). The cost of the debounce,
 * stated: a turn shorter than AGENT_PHASE_DEBOUNCE_MS never commits a run phase
 * and so is never reported — one missed notification, the same benign direction
 * this module already accepts for a restart. The pane heuristic itself is NOT
 * fixed here: `isBusy` also gates delivery and the ship train, and re-tuning it
 * is a delivery-timing change, deliberately out of this scope.
 *
 * ⚠️ Pending state is IN-MEMORY on purpose (the caller holds it; nothing here
 * persists). A restart loses a pending receipt — one missed notification, which
 * is benign. Persisting it would risk firing a receipt twice across a restart,
 * which is the failure that actually hurts, and it is the flood this design
 * exists to avoid. The ship-note latch makes the OPPOSITE trade for exactly the
 * opposite reason: there the persisted set IS the thing that must never
 * double-announce, so losing it is the harmful direction. Don't unify them.
 * ------------------------------------------------------------------ */
import { describeChild } from './atlas-ship-notify.mjs'

// The two DEBOUNCED phases this reads (agent-timings.mjs trackPhase, stamped
// onto every session in both rosters). NOT `status` — see the header.
const RUN = 'run'
const WAIT = 'wait'

// Runaway breaker on the unsolicited half, mirroring atlas-ship-notify's
// MAX_NOTES_PER_CHILD. The edge already bounds turn-end lines to one per turn,
// which is self-limiting (a child at the prompt starts no new turn until someone
// writes to it); this is the backstop for a child that somehow churns phases.
export const MAX_TURN_NOTES_PER_CHILD = 12

const humanMs = (ms) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`)

/* The one cheap "is it BLOCKED on something?" hint the roster actually carries.
 * A numbered choice menu (permission / plan / AskUserQuestion) is parsed off the
 * pane by both executors already, question text included — so saying so costs
 * nothing and is the difference between "it stopped" and "it needs you".
 *
 * Deliberately NOT the trailing-"?" heuristic: the roster's `lastOutput` is
 * lastLine(pane), and on an idle Claude Code that is the footer chrome
 * ("⏵⏵ bypass permissions on …"), never the agent's own last sentence. A
 * prose escalation with no menu therefore reads as a plain turn end, and the
 * note says to read the transcript. */
function waitingHint(child) {
  if (!child || child.menuKind !== 'choice') return ''
  const q = String(child.menuQuestion || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  return q ? ` It is holding a menu open: "${q}".` : ' It is holding a menu open, waiting for a choice.'
}

/* What the parent reads. Deliberately says only THAT it happened — which child,
 * that it went idle after the message, roughly how long that took. Summarising
 * what the child actually did is the AGENT-initiated half of this design (an
 * agent-msg the child sends itself) and is deliberately not attempted here: the
 * system half has to be reliable, and it can only report what the dashboard can
 * observe.
 *
 * `by` names WHO sent the message this receipt answers for — 'parent' (the chat
 * being told) or 'operator' (the dashboard compose box / Telegram). The wording
 * has to differ or the operator-initiated case tells the chat it sent something
 * it never sent. */
export function receiptText(child, waitedMs, by = 'parent') {
  const after =
    by === 'operator'
      ? 'after the OPERATOR messaged it directly (not you)'
      : 'after the message you sent it'
  return `💬 Reply receipt — ${describeChild(child)} has gone IDLE ${humanMs(waitedMs)} ${after}, i.e. it has finished that turn.${waitingHint(child)} Read its transcript (or ask it) for what it actually did. One receipt per message it is sent — this is not a status feed.`
}

/* The unsolicited half: a child you spawned finished a turn nobody was owed a
 * reply for and is now waiting at the prompt. This is the gap the receipt alone
 * left open — a receipt is spent on the turn that consumed its message, so the
 * SECOND escalation of a long-running agent (and every turn of a child nobody
 * ever messaged) reached nobody, on remote bridges most of all, where the child
 * has no `agent-msg` backchannel to tell its parent itself. */
export function turnEndText(child, runMs) {
  const how = runMs ? ` after a ${humanMs(runMs)} turn` : ''
  return `⏸ Turn ended — ${describeChild(child)} has gone IDLE${how} and is now waiting at its prompt.${waitingHint(child)} This answers no message of yours — it is what the dashboard observed. Read its transcript (or ask it) for what it did and whether it is blocked. One line per turn it finishes — this is not a status feed.`
}

/**
 * WHO gets told about this child, and on whose message. Pure (the lineage lookup
 * is injected, like messageAllowed/ownsChild in agent-routes.mjs).
 *
 * The parent chat is told about a message from EITHER end — the operator asked
 * for exactly this: the operator wants to read the Atlas chats and stop walking the dev
 * agents himself, so a receipt that fired only for the chat's own steers would
 * leave the operator relaying their own compose-box prompts. It stays MESSAGE-keyed either
 * way: "always notified" means whoever sent it, NOT on every idle.
 *
 * Two cases return null, and both are silence, not an error:
 *  - the child has no spawn parent (the operator started it from the dashboard,
 *    so no chat exists to tell);
 *  - the sender is a chat that did NOT spawn this child (a sibling orchestrator
 *    steering someone else's agent) — the owning chat never sent that message
 *    and the operator did not ask to be told about another chat's traffic.
 *
 * @param childId    the agent that was messaged
 * @param steeredBy  the chat that sent it, or falsy for an operator prompt
 * @param parentOf   (childId) => parentId | undefined
 * @returns { parentId, by: 'parent'|'operator' } | null
 */
export function receiptParent(childId, steeredBy, parentOf) {
  const owner = parentOf(childId)
  if (!owner) return null
  if (steeredBy && steeredBy !== owner) return null
  return { parentId: owner, by: steeredBy ? 'parent' : 'operator' }
}

// The caller's state: `pending` = armed receipts (childId → who to tell, when
// they asked, whether the message has actually left the queue), `seen` = last
// observed PHASE per session (the previous half of the run→wait edge), `turns` =
// turn-end lines already emitted per child (the breaker's counter).
export function createReceiptState() {
  return { pending: new Map(), seen: new Map(), turns: new Map() }
}

/**
 * ARM one receipt. Returns the next `pending` map (the same reference when
 * nothing changed, so the caller can cheaply tell).
 *
 * COLLAPSE is the whole behaviour of the guard below: a parent that sends three
 * messages before its child next idles gets ONE receipt, not three, and the
 * timestamp stays that of the FIRST — so the elapsed time it reports measures
 * the wait the parent has actually been sitting through.
 *
 * The caller decides WHO may arm (the routes: `steeredBy` must be the child's
 * recorded spawn parent) — that check needs the lineage map and stays there.
 */
export function armReceipt({ pending }, { childId, parentId, at, by = 'parent' }) {
  if (!childId || !parentId) return pending
  if (pending.has(childId)) return pending
  const next = new Map(pending)
  // `delivered:false` — a receipt may not fire for a turn that ended while its
  // message was still parked in the child's queue (see diffReceipts).
  next.set(childId, { parentId, at, by, delivered: false })
  return next
}

const queueDepth = (s) => (Array.isArray(s.queued) ? s.queued.length : 0)

/**
 * FIRE + SPEND: decide which lines this poll owes, from one roster snapshot.
 * Pure — nothing here is mutated, the caller adopts the returned maps.
 *
 * A session missing from `sessions` this tick (a bridge blip) keeps its `seen`
 * entry and its pending receipt, exactly as the ship-note diff keeps its record:
 * so a blip delays a line, it never loses or duplicates one.
 *
 * ⚠️ TWO gates, and the ORDER between them is load-bearing:
 *  1. DELIVERY — the armed message must have been seen to leave the child's
 *     queue on an EARLIER tick than the edge. Read from the incoming `pending`
 *     and only then updated into `nextPending`, so a message that flushes AT the
 *     idle it is waiting for cannot claim the turn that preceded it. (Cheaply
 *     exact in practice: the wait phase commits ~DEBOUNCE_MS after the idle
 *     starts, and flushQueued drains a queue within a tick of it, so a genuinely
 *     consumed message is always observed gone first.)
 *  2. THE EDGE — the child's debounced phase went run→wait. A blip cannot reach
 *     it (it never commits a phase), which is the whole fix.
 * An armed-but-undelivered receipt stays armed and the turn end is reported as
 * the unsolicited 'turn-end' line instead — honest either way, and the receipt
 * still fires on the turn that does consume the message.
 *
 * @param state     { pending, seen, turns } — the caller's live state
 * @param sessions  box-local + remote sessions (publicView shape: id, kind, repo,
 *                  task, phase, lastRunMs, queued, menuKind)
 * @param parentOf  (childId) => parentId | undefined — the spawn lineage
 * @param now       ms, injected so the elapsed time is testable
 * @returns { due, pending, seen, turns, capped }
 */
export function diffReceipts({ pending, seen, turns }, sessions, parentOf = () => undefined, now = Date.now()) {
  const nextSeen = new Map(seen)
  const nextPending = new Map(pending)
  const nextTurns = new Map(turns)
  const due = []
  const capped = []
  for (const s of sessions) {
    if (!s || !s.id) continue
    const before = seen.get(s.id)
    nextSeen.set(s.id, s.phase || null)
    const armed = pending.get(s.id)
    // Gate 1, recorded from THIS tick but only readable by later ones.
    if (armed && !armed.delivered && !queueDepth(s)) nextPending.set(s.id, { ...armed, delivered: true })
    // Gate 2. `before !== RUN` is what stops a line firing on every one of the
    // ticks that follow (wait is true on all of them), and it is also why a
    // freshly-seen child can't fire retroactively: with no previous observation
    // there is no edge to cross.
    if (before !== RUN || s.phase !== WAIT) continue
    // Who to tell: whoever armed the receipt, else the chat that spawned it. A
    // child with neither tells nobody — the operator's own dashboard agents are
    // not somebody else's business.
    const parentId = armed ? armed.parentId : parentOf(s.id)
    if (!parentId) continue
    if (armed && armed.delivered) {
      nextPending.delete(s.id) // SPEND — before the note is even handed off
      const waitedMs = Math.max(0, now - armed.at)
      due.push({ kind: 'reply-receipt', parentId, childId: s.id, waitedMs, by: armed.by, text: receiptText(s, waitedMs, armed.by) })
      continue
    }
    const n = (turns.get(s.id) || 0) + 1
    nextTurns.set(s.id, n)
    if (n > MAX_TURN_NOTES_PER_CHILD) {
      if (n === MAX_TURN_NOTES_PER_CHILD + 1) capped.push(s.id) // report the trip ONCE
      continue
    }
    const runMs = typeof s.lastRunMs === 'number' ? s.lastRunMs : null
    due.push({ kind: 'turn-end', parentId, childId: s.id, runMs, text: turnEndText(s, runMs) })
  }
  return { due, pending: nextPending, seen: nextSeen, turns: nextTurns, capped }
}
