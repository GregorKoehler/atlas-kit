/* ------------------------------------------------------------------ *
 * Tests for the run-time anchor + the record-time clamp (agent-timings.mjs).
 *
 * The incident: the Scorecard's per-day working-time chart showed 2026-07-24 =
 * 37.3 h and 2026-07-25 = 237.1 h against a 1-12 h baseline. Both were phantom.
 * `trackPhase`'s first-observation branch anchored the opening phase at the
 * session's SPAWN time — correct box-local (the 3 s timer sees a session within
 * seconds of spawn), catastrophic for a remote SHADOW, which agent-routes
 * recreates carrying the remote agent's ORIGINAL spawn time whenever a poll
 * drops it: every recreation re-billed the session from its spawn, up to a
 * single 221.8 h `run` record.
 *
 * Guarded here:
 *  - BOX-LOCAL IS UNCHANGED — a session first observed seconds after spawn still
 *    anchors at spawn, so the opening turn keeps counting from when the agent
 *    actually started working. This is the property the fix must not break.
 *  - a STALE spawn (older than AGENT_PHASE_ANCHOR_MAX_AGE_MS) anchors at `now`
 *    instead, so the unobserved gap is counted as neither run nor wait.
 *  - the backstop: a run past AGENT_RUN_MAX_MS is logged clamped, with the raw
 *    duration preserved as `actualMsRaw` + `clamped: true`.
 *
 * Run: node --test api/test/agent-timings-anchor.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-timings-anchor-'))
process.env.AGENT_LOCAL_DIR = dir
const LOG = path.join(dir, 'agent-timings.jsonl')

const { trackPhase } = await import('../src/agent-timings.mjs')

const DEBOUNCE_MS = 7000
const HOUR = 3600000

/** Every `run` record appended since the call started (the log is append-only). */
function runsSince(offset) {
  const text = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf-8') : ''
  return text
    .split('\n')
    .filter(Boolean)
    .slice(offset)
    .map((l) => JSON.parse(l))
    .filter((r) => r.type === 'run')
}
const logLines = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf-8').split('\n').filter(Boolean).length : 0)

/** Drive one busy period: observed running at `openAt`, idle from `idleAt`. */
function runThenIdle(s, openAt, idleAt) {
  trackPhase(s, 'running', openAt)
  trackPhase(s, 'idle', idleAt) // arms the debounce
  trackPhase(s, 'idle', idleAt + DEBOUNCE_MS) // commits at the boundary (= idleAt)
}

test('box-local: a session first observed seconds after spawn still anchors its run at SPAWN', () => {
  const before = logLines()
  const spawn = Date.parse('2026-08-01T10:00:00.000Z')
  const s = { id: 'box-fresh', repo: 'demo-app', startedAt: new Date(spawn).toISOString() }
  // The 3s timer's first sample lands 2s after spawn — the box-local case.
  runThenIdle(s, spawn + 2000, spawn + 120000)

  const [rec] = runsSince(before)
  assert.equal(rec.id, 'box-fresh')
  assert.equal(rec.startedAt, s.startedAt, 'the opening run must still count from spawn, not from first poll')
  assert.equal(rec.actualMs, 120000)
  assert.equal(rec.clamped, undefined)
})

test('remote: a shadow recreated for a days-old session anchors at NOW, not at the stale spawn', () => {
  const before = logLines()
  const spawn = Date.parse('2026-07-16T06:39:13.719Z')
  const observed = spawn + 9 * 24 * HOUR // the shadow is recreated nine days later
  // Exactly what trackRemotePhases builds after a poll dropped the shadow.
  const sh = { id: 'semantics-verify', repo: 'my-app', startedAt: new Date(spawn).toISOString() }
  runThenIdle(sh, observed, observed + 90000)

  const [rec] = runsSince(before)
  assert.equal(Date.parse(rec.startedAt), observed, 'a stale spawn must not anchor the run')
  assert.equal(rec.actualMs, 90000, 'only the observed 90s is work — the nine-day gap is neither run nor wait')
})

test('the clamp: a run past AGENT_RUN_MAX_MS is capped, with the raw duration kept for diagnosis', () => {
  const before = logLines()
  const spawn = Date.parse('2026-08-01T12:00:00.000Z')
  const s = { id: 'runaway', repo: 'my-app', startedAt: new Date(spawn).toISOString() }
  // Anchored legitimately at spawn, then never observed idle for five hours —
  // whatever the cause, that is an observation error, not five hours of work.
  runThenIdle(s, spawn + 1000, spawn + 5 * HOUR)

  const [rec] = runsSince(before)
  assert.equal(rec.actualMs, 4 * HOUR, 'clamped to the default 4h ceiling')
  assert.equal(rec.actualMsRaw, 5 * HOUR, 'the raw duration stays on the record')
  assert.equal(rec.clamped, true)
  assert.equal(s.totalRunMs, 4 * HOUR, "the session's own totals use the clamped value too")
})

test('a normal-length run carries neither clamped nor actualMsRaw', () => {
  const before = logLines()
  const spawn = Date.parse('2026-08-01T14:00:00.000Z')
  const s = { id: 'normal', repo: 'demo-app', startedAt: new Date(spawn).toISOString() }
  runThenIdle(s, spawn + 1000, spawn + 3 * HOUR)

  const [rec] = runsSince(before)
  assert.equal(rec.actualMs, 3 * HOUR)
  assert.equal(rec.clamped, undefined)
  assert.equal(rec.actualMsRaw, undefined)
})
