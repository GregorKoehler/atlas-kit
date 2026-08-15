/* ------------------------------------------------------------------ *
 * Atlas fleet ship notifications — the PURE core (no IO), so it is
 * unit-testable.
 *
 * An Atlas orchestrator (a vault:'atlas' knowledge chat) spawns dev agents via
 * its `spawn_agent` tool. This decides, each poll, when one of those spawned dev
 * agents has crossed a notable SHIP transition — it now reports READY-TO-SHIP,
 * or it has SHIPPED/MERGED — and returns a one-line note to queue back into the
 * orchestrator's OWN chat so the orchestrator stays in the loop on its fleet.
 * The route module applies these (local.queuePrompt) and keeps the state.
 * ------------------------------------------------------------------ */

// An Atlas orchestrator chat — the parent whose own chat we notify.
export function isOrchestrator(s) {
  return !!(s && s.kind === 'knowledge' && s.vault === 'atlas')
}

// A spawned child worth notifying about: a DEV agent (not a knowledge sub-chat
// or the paired 'atlas' ingest worker). Absent kind = dev.
function isDevChild(s) {
  const k = (s && s.kind) || 'dev'
  return k === 'dev'
}

// Short, glance-able description of the child for the orchestrator's note. The
// box-local session list carries no spawn-time title, so fall back to the task.
// Exported so any other note the dashboard sends about a child (e.g. a future
// reply receipt) can name it the same way. Pure formatting — notes that use it
// share NO state.
export function describeChild(child) {
  const what = String(child.task || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  const repo = child.repo ? ` on ${child.repo}` : ''
  // Kind-aware only for a future receipt's sake: a ship note is gated on
  // isDevChild, so this reads exactly as before for every note it produces.
  const who = (child.kind || 'dev') === 'dev' ? 'dev agent' : `${child.kind} agent`
  return `the ${who} you spawned${repo} (${child.id}${what ? ` — "${what}"` : ''})`
}

// The line queued into the orchestrator's chat for a ship transition.
export function noteText(child, state) {
  if (state === 'merged') {
    // Derived from the repo (merged-check.mjs), so this fires however the PR
    // landed — EXCEPT for a merge the recipient performed itself through
    // `merge_pr` (see the mergedBy suppression in diffShipNotes).
    // One line, agent + state + PR/SHA: a "cleanup is safe now" tail would be
    // advice, not news, and wrong for an operator who gates cleanup on merged
    // AND deployed AND the Atlas task closed.
    return `✅ Fleet update — ${describeChild(child)} is MERGED${child.shipInfo ? ` (${child.shipInfo})` : ''}.`
  }
  if (state === 'shipped') {
    return `✅ Fleet update — ${describeChild(child)} has SHIPPED${child.shipInfo ? `: ${child.shipInfo}` : ' (its PR was merged)'}.`
  }
  return `🚀 Fleet update — ${describeChild(child)} now reports it is READY TO SHIP (ATLAS:READY-TO-SHIP). The operator can ship it from the buttons on your chat.`
}

// 'merged' and 'shipped' are TERMINAL: the work landed, and no later reading of
// the ship state can un-land it. Once one has been announced for a child, that
// child is done — see diffShipNotes.
const TERMINAL = new Set(['merged', 'shipped'])
// Circuit breaker: a hard ceiling on notes ever recorded for one child. The
// once-only + terminal-latch rules already bound this at 2; the cap is the
// backstop that guarantees no future flap in this area can fill a chat's queue.
export const MAX_NOTES_PER_CHILD = 3

/**
 * Decide which ship-state notifications to deliver this tick.
 *
 * The state per child is the SET of ship states already announced for it — not
 * its last-seen state — because the only thing that must never happen twice is
 * the announcement:
 *
 *  - First sighting is a SILENT baseline: whatever state the child is in is
 *    recorded as already announced, so a restart, or a child first seen already
 *    past the line, can never announce retroactively.
 *  - Once-only per (child, state), forever — the caller persists this map, so it
 *    holds across restarts too.
 *  - Terminal states LATCH: after 'merged'/'shipped' has been announced, nothing
 *    more is ever emitted for that child. A backwards flap (→ 'ready', → null)
 *    is silent by construction.
 *  - `next` is prev MERGED with this tick's updates, never a fresh map: a child
 *    transiently missing from `sessions` (a bridge blip) keeps its record.
 *  - A 'merged' the RECIPIENT caused itself (it merged the PR through `merge_pr`)
 *    is SUPPRESSED — see `mergedBy` below.
 *
 * @param prev      Map<childId, string[]>  ship states already announced per child
 * @param sessions  box-local + remote sessions (publicView shape: id, kind, vault, repo, task, shipState, shipInfo)
 * @param parentOf  (childId) => parentId | undefined     the spawn-lineage lookup
 * @param mergedBy  (childId) => orchestratorId | undefined  who merged that child's PR
 * @returns { notes: Array<{parentId, childId, state, text}>, next: Map, changed: boolean, capped: string[], suppressed: Array<{parentId, childId, state}> }
 */
export function diffShipNotes(prev, sessions, parentOf, mergedBy = () => undefined) {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const next = new Map(prev)
  const notes = []
  const capped = []
  const suppressed = []
  let changed = false
  for (const s of sessions) {
    if (!isDevChild(s)) continue
    const parentId = parentOf(s.id)
    if (!parentId || !isOrchestrator(byId.get(parentId))) continue
    const state = s.shipState || null // 'ready' | 'shipped' | 'merged' | null
    const seen = prev.get(s.id)
    if (!seen) {
      next.set(s.id, state ? [state] : []) // first sighting → baseline only
      changed = true
      continue
    }
    if (!state) continue // back to null (a new task after a ship) → silent
    if (seen.includes(state)) continue // already announced
    if (seen.some((x) => TERMINAL.has(x))) continue // terminal latched
    if (seen.length >= MAX_NOTES_PER_CHILD) {
      capped.push(s.id)
      continue
    }
    // Don't tell an orchestrator about a state change IT caused. The only such
    // change is 'merged': the orchestrator merged this child's PR itself, and the
    // repo-derived verdict then reports its own action back minutes later. It is
    // scoped to the chat that MERGED — a note for the same child to a DIFFERENT
    // parent, or a merge by the operator on github.com / another Atlas chat (no
    // claim at all), is unaffected and fires exactly as before. Never applied to
    // 'ready' (the dev agent's own signal — nothing else surfaces it) or to
    // 'shipped' (the dev agent merged its own PR, not the orchestrator).
    // The state still LATCHES: the announcement for this (child, state) is
    // settled, so the once-only/terminal guards are untouched — this sits on top
    // of them and never becomes the bound.
    if (state === 'merged' && mergedBy(s.id) === parentId) {
      suppressed.push({ parentId, childId: s.id, state })
      next.set(s.id, [...seen, state])
      changed = true
      continue
    }
    notes.push({ parentId, childId: s.id, state, text: noteText(s, state) })
    next.set(s.id, [...seen, state])
    changed = true
  }
  return { notes, next, changed, capped, suppressed }
}

// How many ticks a single note may fail to hand off before we give up on it.
// The retry exists because a latch that advances BEFORE delivery loses any
// failed note forever; the cap exists so a recipient that is gone (or
// permanently rejecting) converges instead of retrying every few seconds forever.
export const SHIP_NOTE_MAX_TRIES = Number(process.env.ATLAS_SHIP_NOTE_MAX_TRIES || 5)

/**
 * Apply one pass's diff — the half that must NOT be pure guesswork about
 * delivery. Two kinds of update come out of diffShipNotes:
 *
 *  - BASELINE entries (first sighting; nothing to deliver) land immediately.
 *  - A NOTE's entry lands ONLY once that note has actually been handed off.
 *    Advancing it first marks a note "announced" that was never delivered —
 *    `queuePrompt` fails for ordinary reasons (the recipient isn't running, its
 *    queue is full) — and the once-per-(child,state) latch then guarantees it is
 *    never retried. That is a permanent, silent loss.
 *
 * A failed note therefore stays UNLATCHED and the next tick re-derives it from
 * the child's current ship state — which is also why a retry can't duplicate:
 * the note is never emitted twice for the same (child, state), only ever emitted
 * once *successfully*. After `maxTries` failures we latch anyway and report
 * `gaveUp` so the caller can be loud about it; that is the only path on which a
 * note is dropped, and it is bounded and visible.
 *
 * Delivery IO is injected (`deliver`), so this stays unit-testable without tmux.
 *
 * @param state   Map<childId, string[]>  the live latch (mutated in place)
 * @param notes   this pass's notes, in order (at most one per child)
 * @param next    diffShipNotes' merged map — the value each entry advances TO
 * @param fails   Map<"child state", tries>  cross-tick attempt counter (mutated)
 * @param deliver async (note) => { ok, error? }   the hand-off (queuePrompt)
 * @param persist called after each latch advance, so a crash can't re-announce
 * @returns { results: Array<note & { delivered, tries, gaveUp?, error? }> }
 */
export async function deliverShipNotes({ state, notes, next, fails, deliver, persist = () => {}, maxTries = SHIP_NOTE_MAX_TRIES }) {
  const pending = new Set(notes.map((n) => n.childId))
  let dirty = false
  for (const [k, v] of next) {
    if (pending.has(k)) continue // latched below, after its note lands
    // `state.has(k)` FIRST — the skip may never be decided by value alone. An
    // EMPTY baseline (`[]`: seen, nothing announced yet) joins to '' exactly like
    // a missing entry, so `(state.get(k) || []).join(...)` compares the two equal
    // and refuses to persist it. The child then stays permanently "never seen",
    // and the poll where it first turns 'ready' is read as its FIRST SIGHTING —
    // silently baselined at ['ready'] by diffShipNotes. That makes the ready note
    // structurally unreachable, for every child, always. Anti-retroactive
    // baselining is untouched: a child first seen ALREADY past the line still
    // baselines at [state] and stays silent.
    if (state.has(k) && state.get(k).join(' ') === v.join(' ')) continue
    state.set(k, v)
    dirty = true
  }
  if (dirty) persist()

  const results = []
  // Sequential on purpose: notes are observations, so a later state must never
  // overtake an earlier one, and a throw mid-loop must not cost the rest of the
  // pass (they simply stay unlatched and come back next tick).
  for (const n of notes) {
    const key = `${n.childId} ${n.state}`
    let r
    try {
      r = await deliver(n)
    } catch (e) {
      r = { ok: false, error: e.message }
    }
    if (r && r.ok) {
      fails.delete(key)
      state.set(n.childId, next.get(n.childId))
      persist()
      results.push({ ...n, delivered: true })
      continue
    }
    const tries = (fails.get(key) || 0) + 1
    const error = (r && r.error) || 'delivery failed'
    if (tries < maxTries) {
      fails.set(key, tries) // NOT latched → the next tick tries again
      results.push({ ...n, delivered: false, tries, gaveUp: false, error })
      continue
    }
    fails.delete(key)
    state.set(n.childId, next.get(n.childId)) // give up → converge, loudly (caller logs)
    persist()
    results.push({ ...n, delivered: false, tries, gaveUp: true, error })
  }
  return { results }
}

// (de)serialization for the on-disk announced-set (the caller persists `next` so
// a redeploy can't re-announce). Tolerates a hand-edited/garbage file by dropping
// anything that isn't a childId → string[] entry.
export function parseShipNotes(obj) {
  const map = new Map()
  if (!obj || typeof obj !== 'object') return map
  for (const [id, states] of Object.entries(obj)) {
    if (Array.isArray(states)) map.set(id, states.filter((x) => typeof x === 'string'))
  }
  return map
}
export function dumpShipNotes(map) {
  return Object.fromEntries(map)
}
