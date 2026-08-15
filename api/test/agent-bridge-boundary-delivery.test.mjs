/* ------------------------------------------------------------------ *
 * Boundary delivery for BRIDGE (workstation / demo) agents — the
 * remote half of the box's per-kind queued-prompt gate.
 *
 * an earlier change relaxed delivery box-local only: a `steer`/`operator`/`agent-msg`
 * now lands at the running turn's next TOOL-CALL BOUNDARY instead of waiting
 * for a full idle (measured on the box: 237,694 ms → 1,110 ms on the identical
 * path). `agent-bridge/server.mjs` kept its own idle-only `flushQueued`, so
 * remote agents kept the old tail.
 *
 * The bridge server cannot be imported (it binds a port and exits without a
 * token), so — same convention as agent-message-bus-remote.test.mjs and
 * atlas-query-relay.test.mjs — the bridge half is asserted against its SOURCE,
 * scoped to the two functions that changed. The decision itself is pure and
 * already covered behaviourally by queue-delivery.test.mjs; what is genuinely
 * new here is that the bridge (a) persists what the decision reads, (b) calls
 * the SHARED decision rather than a copy, and (c) records `waitMs` at all —
 * without which there is no bridge baseline and no way to prove any of this.
 *
 * Run: node --test api/test/agent-bridge-boundary-delivery.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { decideDelivery, classifyKind } from '../src/queue-delivery.mjs'

const src = fs.readFileSync(new URL('../../agent-bridge/server.mjs', import.meta.url), 'utf-8')
const routes = fs.readFileSync(new URL('../src/agent-routes.mjs', import.meta.url), 'utf-8')

// Scope the assertions to the function that owns the behaviour, so an unrelated
// match elsewhere in a 1900-line server can't make one of these pass.
function fn(name, endMarker) {
  const start = src.indexOf(`async function ${name}(`)
  assert.ok(start > 0, `${name} not found in agent-bridge/server.mjs`)
  const end = src.indexOf(endMarker, start)
  assert.ok(end > start, `end of ${name} not found`)
  return src.slice(start, end)
}
const queuePrompt = fn('queuePrompt', '\n// Cancel a parked prompt')
const flushQueued = fn('flushQueued', '\nconst flushTimer')
// The "this must NOT appear" assertions are about CODE — the comments here
// deliberately name the box's ship train and its kill-switch to explain why the
// bridge has neither, and prose must not fail (or pass) a structural check.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
const srcCode = code(src)

/* --- 1. persist what the gate reads ---------------------------------- *
 * Without this the gate is a no-op: every entry reads back untagged, and
 * untagged is idle-only by design (unknown fails safe). */

test('queuePrompt keeps `kind` and stamps the enqueue time', () => {
  assert.match(queuePrompt, /async function queuePrompt\(\{[^}]*\bkind\b[^}]*\}\)/, '`kind` must be destructured — the box already sends it')
  const push = queuePrompt.match(/queued\.push\(.*\)/)
  assert.ok(push, 'the queue push line not found')
  assert.match(push[0], /at: nowIso\(\)/, 'no enqueue stamp → no waitMs')
  assert.match(push[0], /\.\.\.\(kind \? \{ kind \} : \{\}\)/, 'kind dropped on the way into the queue')
  // The `queue` audit line names the kind too, so enqueue and flush pair up.
  assert.match(queuePrompt, /action: 'queue',[^\n]*\.\.\.\(kind \? \{ kind \} : \{\}\)/)
})

/* --- 2. one decision, not two ---------------------------------------- */

test('flushQueued uses the SHARED decision, not a bridge-local copy', () => {
  assert.match(src, /import \{ selectDelivery[^}]*\} from '\.\.\/api\/src\/queue-delivery\.mjs'/, 'one gate source, not a copy')
  // The scan (which entry may go out, given the pane) is the shared module's
  // too — a bridge that kept picking `queued[0]` would keep the head-of-line
  // block the box no longer has.
  assert.match(flushQueued, /const sel = selectDelivery\(\{/)
  assert.match(flushQueued, /queue: s\.queued/)
  assert.match(flushQueued, /busy: isBusy\(pane\)/)
  assert.match(flushQueued, /menu: !!menuKindOf\(pane\)/)
  assert.match(flushQueued, /if \(!sel\.pick\) continue/)
  // A bridge-side taxonomy would be exactly the drift the shared module prevents.
  assert.doesNotMatch(srcCode, /BOUNDARY_KINDS/, 'the bridge must not classify kinds itself')
})

test('the bridge has no ship train, so shipHead is hardcoded false', () => {
  assert.match(flushQueued, /shipHead: false/)
  // Verified, not assumed: the serial merge queue is box-local (a remote agent
  // ships concurrently), so there is nothing on the bridge to hold delivery for.
  assert.doesNotMatch(srcCode, /shipHeadActiveId|shipQueue/)
})

test('the kill-switch is the bridge\'s own env, independently revertible', () => {
  assert.match(src, /BRIDGE_BOUNDARY_DELIVERY/)
  assert.doesNotMatch(srcCode, /AGENT_BOUNDARY_DELIVERY/, 'a bridge machine restarts separately from the box')
  assert.match(src, /const BOUNDARY_DELIVERY = !\/\^\(0\|false\|no\|off\)\$\/i\.test\(process\.env\.BRIDGE_BOUNDARY_DELIVERY \|\| '1'\)/)
  assert.match(flushQueued, /boundaryEnabled: BOUNDARY_DELIVERY/)
})

test('mid-turn deliveries are paced by the same stamp the box uses', () => {
  // At idle the pacing came free (delivery made the agent busy); mid-turn nothing
  // paces it, so a 3 s flush tick would burst a whole queue into one turn.
  assert.match(flushQueued, /sinceBoundaryMs: s\.boundaryAt \? Date\.now\(\) - s\.boundaryAt : null/)
  assert.match(flushQueued, /if \(dec\.via === 'boundary'\) s\.boundaryAt = Date\.now\(\)/)
})

/* --- 3. make it measurable ------------------------------------------- */

test('the queue-flush audit line carries waitMs / via / kind, matching the box', () => {
  assert.match(flushQueued, /const waitMs = q\.at \? Date\.now\(\) - Date\.parse\(q\.at\) : null/)
  const line = flushQueued.match(/audit\(\{ action: 'queue-flush',[^\n]*\)/)
  assert.ok(line, 'queue-flush audit line not found')
  assert.match(line[0], /\.\.\.\(waitMs != null && waitMs >= 0 \? \{ waitMs \} : \{\}\)/)
  assert.match(line[0], /via: dec\.via/)
  assert.match(line[0], /\.\.\.\(q\.kind \? \{ kind: q\.kind \} : \{\}\)/)
  // Byte-identical field set to agent-local.mjs's line, so ONE grep works across
  // both executors' audit logs — the whole point of adding it here.
  const box = fs.readFileSync(new URL('../src/agent-local.mjs', import.meta.url), 'utf-8')
  const boxLine = box.match(/audit\(\{ action: 'queue-flush',[^\n]*\)/)
  const fields = (s) => (s.match(/\b(waitMs|via|kind|len|images|ok)\b/g) || []).sort().join(',')
  assert.equal(fields(line[0]), fields(boxLine[0]))
})

/* --- 4. what must not regress ---------------------------------------- */

test('flushQueued never interrupts, and stays one delivery per tick', () => {
  // ⚠️ Escape marks a session interrupted/lost . Delivery is a plain
  // send-keys; only the operator's explicit "send now" may interrupt.
  assert.doesNotMatch(flushQueued, /Escape|interrupt\(/)
  assert.match(flushQueued, /const q = sel\.pick\.entries\[0\]/, 'the entry the shared scan picked')
  assert.equal((flushQueued.match(/await deliver\(/g) || []).length, 1, 'one delivery per session per tick')
  // ⚠️ Removal is by IDENTITY, not `shift()`: the picked entry need not be the
  // head any more (a boundary-eligible message may overtake an idle-only one),
  // and shifting would drop somebody else's message unread.
  assert.match(flushQueued, /s\.queued\.filter\(\(e\) => !picked\.has\(e\)\)/)
  assert.doesNotMatch(code(flushQueued), /s\.queued\.shift\(\)/)
})

test('the menu guard still gates every bridge delivery', () => {
  // It moved INTO the shared decision (ahead of every kind branch), which is the
  // only place it may live — a keystroke into a menu is a selection, not text.
  assert.match(flushQueued, /menu: !!menuKindOf\(pane\)/)
  for (const kind of ['steer', 'operator', 'agent-msg', 'fleet-note', undefined]) {
    for (const busy of [true, false]) {
      assert.deepEqual(
        decideDelivery({ kind, busy, menu: true, shipHead: false, boundaryEnabled: true, sinceBoundaryMs: null }),
        { deliver: false, reason: 'menu' },
        `kind ${String(kind)} busy=${busy}`,
      )
    }
  }
})

/* --- 5. the kind that actually reaches a bridge ------------------------ *
 * A persisted `kind` only helps if the box stamps one on the way out. One path
 * queues to a bridge with a kind today; the rest are deliberately untagged
 * (scheduled prompts, the remote ship prompt) and stay idle-only. Peer mail is
 * the second: the box stamps `kind:'agent-msg'` on the bridge branch of
 * deliverAgentMessage, and the bridge gates on that same string — if the two
 * ever drift, remote peer mail silently degrades to idle-only and waits out the
 * whole turn it was sent to interrupt. */

test('the box stamps a boundary-eligible kind on the path that reaches a bridge', () => {
  // POST /api/agents/queue — steer (has steeredBy) or operator, then forwarded.
  const start = routes.indexOf("router.post('/api/agents/queue'")
  assert.ok(start > 0, 'the queue route not found in agent-routes.mjs')
  const queueRoute = routes.slice(start, start + 800)
  assert.match(queueRoute, /body\.kind = body\.steeredBy \? 'steer' : 'operator'/)
  assert.match(queueRoute, /callBridgeForId\('POST', '\/queue', body,/, 'the stamped body itself must be forwarded')
  // Peer mail to a REMOTE recipient: the same kind, stamped on the bridge call.
  assert.match(routes, /callBridge\('POST', '\/queue', \{ id: to, text: body,[^}]*kind: 'agent-msg'[^}]*\}/)
  for (const k of ['steer', 'operator', 'agent-msg']) assert.equal(classifyKind(k), 'boundary')
})
