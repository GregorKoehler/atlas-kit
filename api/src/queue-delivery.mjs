/* ── WHEN a parked prompt goes out ──────────────────────────────────────────
 * The pure decision behind BOTH executors' `flushQueued` — the box-local
 * agent-local.mjs and the remote agent-bridge/server.mjs: given a session's
 * queue and what the pane looks like, WHICH message goes out now
 * (`selectDelivery`, further down), and for one entry, may it (`decideDelivery`).
 * Shared rather than mirrored so the two cannot drift on the one thing they must
 * agree about — which kinds may land mid-turn. Split out so the gate is testable
 * without a live tmux (queue-delivery.test.mjs).
 *
 * What each executor supplies for itself: the ship train (box-local only — the
 * bridge passes `shipHead: false`) and the kill-switch env, which is deliberately
 * per-executor (`AGENT_BOUNDARY_DELIVERY` on the box, `BRIDGE_BOUNDARY_DELIVERY`
 * on a bridge) because a bridge machine is restarted separately from the box.
 *
 * Delivery used to wait for the session's next FULL IDLE. That is a pane
 * heuristic ("esc to interrupt" is on screen for the WHOLE turn), and an
 * autonomous dev agent runs one long turn — so measured over 55 real flushes
 * (`audit.log` queue-flush waitMs) the wait was min 0.16 s · median 6.8 s ·
 * max 2,634 s (43.9 min). The tail is the failure case, and it is exactly the
 * one that matters: a busy agent is precisely when you want to reach it.
 *
 * Measured upstream: Claude Code already surfaces a mid-turn message at the
 * next TOOL-CALL BOUNDARY — a marker typed into a busy agent came back attached
 * to the first tool result of a 15-call turn, prefixed by the harness with "The
 * user sent a new message while you were working", attribution header intact.
 * So the idle gate was withholding delivery for a problem the harness already
 * solves upstream.
 *
 * Delivery is therefore PER-KIND, not all-or-nothing — a message that lands
 * mid-turn can be worse than one that lands late if it derails reasoning in
 * flight, so only the kinds meant to CHANGE what the agent is doing jump the
 * queue; observational ones keep waiting for idle. An unmapped kind is
 * idle-only: unknown fails safe, i.e. to today's behaviour.
 */

// Boundary-eligible: messages whose whole point is to change course.
//   'steer'     — an orchestrator/MCP `queue_agent` (POST /api/agents/queue with
//                 `steeredBy`), incl. an answer to something the agent asked.
//   'operator'  — the operator's own Queue from the dashboard compose box.
//   'agent-msg' — peer mail off the agent↔agent bus. Classified in ONE place so
//                the two executors cannot disagree: the box stamps a remote send
//                with this kind (agent-routes' deliverAgentMessage) and the
//                bridge gates on it, so the two must match exactly or remote
//                peer mail silently degrades to idle-only.
//   'reply-receipt' — ⚠️ its TRUST class and its DELIVERY class are DIFFERENT
//                 AXES, and they look contradictory on purpose; do not "fix" it
//                 by moving this line down. Trust: an OBSERVATION, exactly like
//                 a fleet note — the dashboard derived it from a child's status,
//                 nobody typed it, and it carries the system attribution header.
//                 Delivery: BOUNDARY, unlike a fleet note — a receipt is
//                 SOLICITED (the parent messaged that child) and addressed to
//                 the one chat that asked, so the reason observational kinds are
//                 held ("don't derail a turn with an unsolicited broadcast")
//                 simply does not apply. A parent waiting on a child is the case
//                 where lateness costs the most, and idle-only would hand this
//                 feature back the exact 43.9-min tail it exists to remove.
//   'turn-end'  — the receipt's unsolicited sibling: a child you SPAWNED stopped
//                 and is waiting at its prompt. Boundary for the same reason and
//                 with the same narrow audience — one chat, about its own child,
//                 and it is precisely the trigger for that chat's next move. It
//                 is NOT the broadcast a fleet note is (which is why fleet notes
//                 stay idle-only), and BOUNDARY_MIN_GAP_MS still paces it.
// Everything else is IDLE-ONLY, and that is the default:
//   'fleet-note'  — ⚙ automatic fleet updates (ready/shipped/merged): pure
//                   observation, explicitly not instruction.
//   'atlas-brief' — 📚 background context, not a course change (and no longer
//                   queued at all — evidence is folded into the spawn).
//   undefined     — an untagged queue (e.g. a scheduled prompt, whose own
//                   contract is "never mid-turn"), or any kind added later.
export const BOUNDARY_KINDS = new Set(['steer', 'operator', 'agent-msg', 'reply-receipt', 'turn-end'])

export function classifyKind(kind) {
  return BOUNDARY_KINDS.has(kind) ? 'boundary' : 'idle'
}

// Pacing for mid-turn delivery. At idle the pacing came free — delivering made
// the agent busy, so the next queued prompt waited for its own turn ("each
// queued prompt gets its own turn, in order"). Mid-turn nothing paces
// it: a busy agent stays busy, so a 3 s flush tick would empty a whole queue
// into one turn in a burst. One boundary delivery per minute per session keeps
// FIFO and keeps them apart, while still turning a 43.9-min tail into seconds.
export const BOUNDARY_MIN_GAP_MS = 60_000

/* ── Backing off a queue head that will not go out ───────────────────────────
 * A refused delivery leaves the message at the head, so the next tick retries
 * it — and in the incident this fixes that was 24 attempts in 75 s on one chat,
 * each one typing 678 more characters at it. Retrying a failure at the tick
 * rate is only ever right when the failure is transient; a read-back refusal
 * says something about the PANE, which does not change in 3 s.
 *
 * So: two free retries (a genuinely transient miss — a pane that lagged, a
 * `send-keys` that raced a redraw — costs nothing to repeat), then exponential.
 * The message is NOT dropped; the queue keeps it and the wait is audited, which
 * is the point — a stuck delivery should be loud and cheap, not silent and hot.
 */
export const DELIVER_FAIL_GRACE = 2
export const DELIVER_BACKOFF_BASE_MS = 30_000
export const DELIVER_BACKOFF_MAX_MS = 10 * 60_000

export function deliveryBackoffMs(failures) {
  const n = Number(failures) || 0
  if (n <= DELIVER_FAIL_GRACE) return 0
  return Math.min(DELIVER_BACKOFF_MAX_MS, DELIVER_BACKOFF_BASE_MS * 2 ** (n - DELIVER_FAIL_GRACE - 1))
}

/**
 * Decide the FIFO head of one session's queue.
 *
 * @param {object} o
 * @param {string} [o.kind]              queue entry's kind (undefined = untagged)
 * @param {boolean} o.busy               isBusy(pane) — a turn is running
 * @param {boolean} o.menu               !!menuKindOf(pane) — a menu is open
 * @param {boolean} o.shipHead           this session is merging at the ship-train head
 * @param {boolean} o.boundaryEnabled    AGENT_BOUNDARY_DELIVERY kill-switch
 * @param {number|null} o.sinceBoundaryMs  ms since this session's last boundary
 *                                         delivery (null = never)
 * @returns {{deliver: true, via: 'idle'|'boundary'} | {deliver: false, reason: string}}
 */
export function decideDelivery({ kind, busy, menu, shipHead, boundaryEnabled, sinceBoundaryMs }) {
  // ⚠️ A parked prompt must never land mid git-merge (the ship train delivers
  // its own ship prompt; this member's other queued prompts wait it out).
  if (shipHead) return { deliver: false, reason: 'ship-train' }
  // ⚠️ Typing into a MENU is a selection, not text (a blind keystroke
  // once killed a worker). A tool-call boundary and an open menu can look alike
  // from the pane, so relaxing the busy gate must never relax this one.
  if (menu) return { deliver: false, reason: 'menu' }
  if (!busy) return { deliver: true, via: 'idle' }
  if (!boundaryEnabled) return { deliver: false, reason: 'busy' }
  if (classifyKind(kind) !== 'boundary') return { deliver: false, reason: 'idle-only' }
  if (sinceBoundaryMs != null && sinceBoundaryMs < BOUNDARY_MIN_GAP_MS) return { deliver: false, reason: 'paced' }
  return { deliver: true, via: 'boundary' }
}

/* ── A note that aged in the queue is not the note that was written ──────────
 * The incident this half exists for: one Atlas orchestrator ran a single ~7 h
 * turn while it spawned, merged and cleaned up 8 dev agents. Its queue reached
 * 20. When the turn finally ended, ~15 notes drained ONE PER TURN — 🚀
 * READY-TO-SHIP fleet notes and ⏸ Turn ended lines about children whose PRs that
 * same session had merged hours earlier and whose sessions it had already torn
 * down. Every one was moot, each cost a whole wake-up turn, and none of them
 * said WHEN it had been observed, so the recipient could not even tell. Four
 * things were wrong and all four are in this module:
 *
 *   1. an observation carried no observation TIME (`observedAt` + `ageLine`);
 *   2. it was delivered without ever being re-checked (`selectDelivery`'s
 *      `revalidate` callback + the intra-queue supersession rule below);
 *   3. an idle-only head BLOCKED the boundary-eligible messages behind it —
 *      turn-end lines did land at tool-call boundaries early in that turn and
 *      stopped the moment a `fleet-note` reached the head (the scan below);
 *   4. the survivors drained one per turn instead of once (`deliveryText`'s
 *      digest).
 *
 * ⚠️ OBSERVATIONAL is a THIRD axis, next to trust and delivery class — and
 * `turn-end` is deliberately in a different bucket on two of them: its trust
 * class is observation, its DELIVERY class is boundary (it is about one chat's
 * own child, so it may land mid-turn), and it is REVALIDATABLE, because "it is
 * waiting at its prompt" is a claim about the world that expires. A
 * `reply-receipt` is NOT in here on purpose: it answers a message its recipient
 * actually sent, so it is delivered however late — it only gets the age line. */
export const OBSERVATIONAL_KINDS = new Set(['fleet-note', 'turn-end'])
export const isObservational = (kind) => OBSERVATIONAL_KINDS.has(kind)

// Above this age a delivered note SAYS how old it is. Under it, no clutter —
// the overwhelmingly common case is a note that waits one 3 s flush tick.
export const NOTE_AGE_DISCLOSE_MS = Number(process.env.AGENT_NOTE_AGE_DISCLOSE_MS || 60_000)

const clock = (ms) => new Date(ms).toTimeString().slice(0, 5)

export function humanAge(ms) {
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** The disclosure line, or '' when the note is fresh (or carries no observation
 *  time at all — an un-stamped kind must read exactly as it always has). */
export function ageLine(observedAt, now = Date.now(), thresholdMs = NOTE_AGE_DISCLOSE_MS) {
  if (!observedAt) return ''
  const age = now - observedAt
  if (age <= thresholdMs) return ''
  return `⏱ Observed at ${clock(observedAt)}, ${humanAge(age)} before this delivery — it aged in your queue while your turn ran, so check it is still true before acting on it.`
}

/**
 * The text actually typed at the recipient.
 *
 * ⚠️ The attribution header stays FIRST. It is what the chat view falls back to
 * when the send-time fingerprint is gone (web/src/lib/msgProvenance.ts anchors
 * `⚙ **Automatic fleet update` at the START of the message), so an age line or a
 * digest intro prefixed ahead of it would silently repaint a machine
 * observation in the operator's own colour. Hence `header` + `note` on the
 * entry: the pieces, not a string to be split back apart.
 *
 * One fresh note returns `entry.text` BYTE-IDENTICALLY — the un-stamped,
 * under-threshold, single-message path is exactly what it always was.
 */
export function deliveryText(entries, now = Date.now(), thresholdMs = NOTE_AGE_DISCLOSE_MS) {
  if (entries.length === 1) {
    const e = entries[0]
    const line = ageLine(e.observedAt, now, thresholdMs)
    if (!line) return e.text || ''
    return e.header && e.note ? `${e.header}\n\n${line}\n\n${e.note}` : `${line}\n\n${e.text || ''}`
  }
  const body = [
    `⚙ Fleet digest — ${entries.length} observations the dashboard made while your turn ran, oldest first. The clock time on each line is when it was OBSERVED, not now; some of it may already be moot. None of it is an instruction — check anything you mean to act on.`,
    ...entries.map((e) => `• ${e.observedAt ? clock(e.observedAt) : '--:--'} — ${String(e.note || e.text).replace(/\s+/g, ' ').trim()}`),
  ].join('\n')
  const header = entries[0].header
  return header ? `${header}\n\n${body}` : body
}

/**
 * Pick what this session may deliver THIS tick, from its whole queue.
 *
 * `decideDelivery` above answers for ONE entry; this is the loop around it, and
 * the loop is where the head-of-line bug lived. `flushQueued` used to ask about
 * `queued[0]` alone, so a single idle-only `fleet-note` at the head parked every
 * boundary-eligible message behind it for the rest of the turn. It now scans for
 * the first entry the gate ALLOWS given the pane — which at idle is still the
 * FIFO head, because at idle the gate allows everything.
 *
 * Order WITHIN a class never changes (the scan preserves queue order and only
 * ever skips entries the gate refuses), and nothing here relaxes the menu, the
 * ship-train or the BOUNDARY_MIN_GAP_MS pacing — those all live in
 * `decideDelivery` and are consulted per entry.
 *
 * Two drops happen before the scan, both only ever to OBSERVATIONAL entries:
 *  - `revalidate(entry)` — the executor's callback into current child state
 *    (gone / superseded / self-merged). Injected rather than forked, so the
 *    rule is one implementation and testable without a live roster.
 *  - SUPERSESSION inside the queue itself — a later queued entry about the same
 *    child makes an earlier observation about it moot, which needs no state at
 *    all. A dropped entry does not supersede anything (it is not being
 *    delivered either), so this is computed back-to-front.
 *
 * @returns {{drops: Array<{entry: object, reason: string}>, pick: null|{entries: object[], via: 'idle'|'boundary', digest: boolean}, hold?: string}}
 *          Entries come back BY REFERENCE — the caller removes them from its
 *          queue by identity, never by index (the drop pass shifts every index).
 */
export function selectDelivery({ queue, revalidate = () => null, busy, menu, shipHead, boundaryEnabled, sinceBoundaryMs }) {
  const stale = new Map() // entry -> reason
  const seenChild = new Set()
  for (let i = queue.length - 1; i >= 0; i--) {
    const e = queue[i]
    const childId = e.about && e.about.childId
    if (isObservational(e.kind)) {
      const reason = childId && seenChild.has(childId) ? `superseded by a later queued note about ${childId}` : revalidate(e) || null
      if (reason) {
        stale.set(e, reason)
        continue // a dropped note supersedes nothing
      }
    }
    if (childId) seenChild.add(childId)
  }
  const survivors = queue.filter((e) => !stale.has(e))
  const drops = queue.filter((e) => stale.has(e)).map((entry) => ({ entry, reason: stale.get(entry) }))

  let pick = null
  let hold
  for (const e of survivors) {
    const d = decideDelivery({ kind: e.kind, busy, menu, shipHead, boundaryEnabled, sinceBoundaryMs })
    if (d.deliver) {
      pick = { entries: [e], via: d.via, digest: false }
      break
    }
    if (!hold) hold = d.reason
  }
  // At a full idle, the surviving observations go out as ONE wake-up rather
  // than one per turn. Boundary deliveries are never batched: a message that
  // lands mid-turn is meant to be read on its own.
  if (pick && pick.via === 'idle' && isObservational(pick.entries[0].kind)) {
    const batch = survivors.filter((e) => isObservational(e.kind))
    if (batch.length > 1) pick = { entries: batch, via: 'idle', digest: true }
  }
  return { drops, pick, ...(hold ? { hold } : {}) }
}

/* ── Is this observation still TRUE? ─────────────────────────────────────────
 * The pure half of the `revalidate` callback: the executor supplies the child's
 * CURRENT roster row (and whether the recipient merged that child's PR itself),
 * this decides. Null = still worth delivering.
 *
 * `child` absent means the session is GONE — torn down or cleaned up, which in
 * the incident was true of every note that drained. An entry with no `about`
 * is never revalidated: nothing is known about what it claims.
 */
const SHIP_RANK = { ready: 1, shipped: 2, merged: 2 }

export function noteStaleReason(entry, { child, mergedBySelf } = {}) {
  // A `reply-receipt` is not observational and is never called stale — however
  // late it is, it answers a message its recipient actually sent. (The
  // selection never asks about one either; this makes the rule self-contained.)
  if (!entry || !isObservational(entry.kind)) return null
  const about = entry.about
  if (!about || !about.childId) return null
  if (!child) return `${about.childId} is gone — the session was torn down after this was observed`
  if (entry.kind === 'fleet-note') {
    // A merge the RECIPIENT performed itself: the claim exists, so the note is
    // its own action reported back. (diffShipNotes suppresses this at
    // observation time; a note already in the queue when the merge happened is
    // what this catches.)
    if (mergedBySelf) return `${about.childId} was merged by this chat itself`
    const now = SHIP_RANK[child.shipState] || 0
    const then = SHIP_RANK[about.state] || 0
    if (now > then) return `${about.childId} is now ${child.shipState}, past the ${about.state} this reported`
  }
  // "it is waiting at its prompt" is a claim about the world, and a child that
  // has started another turn since has falsified it.
  if (entry.kind === 'turn-end' && child.phase === 'run') return `${about.childId} has started another turn since`
  return null
}
