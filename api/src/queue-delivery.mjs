/* ── WHEN a parked prompt goes out ──────────────────────────────────────────
 * The pure decision behind BOTH executors' `flushQueued` — the box-local
 * agent-local.mjs and the remote agent-bridge/server.mjs: given
 * one queued FIFO head and what the pane looks like, deliver now or hold for a
 * later tick. Shared rather than mirrored so the two cannot drift on the one
 * thing they must agree about — which kinds may land mid-turn. Split out so the
 * gate is testable without a live tmux (queue-delivery.test.mjs).
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
