/* ------------------------------------------------------------------ *
 * Tests for the chat-send client (api.ts): `promptAgent`'s ONE automatic
 * retry, and how a failed send is classified and reported.
 *
 * The pane trails the keystrokes, so the executor's read-back can give up on a
 * busy or repainting pane — an honest refusal (502 + `notDelivered`) whose
 * identical payload lands on a resend seconds later. The client does that
 * resend, exactly once.
 *
 * ⚠️ What the retry keys on is the SAFETY PROOF, not the status alone:
 * `notDelivered` is the executor's statement that it submitted nothing and
 * cleared the input box. A 502 without it is a transport failure ("bridge
 * unreachable", an edge's HTML page) where the prompt may well have landed —
 * re-sending that would double-send, so the negative cases below matter as much
 * as the positive one.
 *
 * Runs the real module via node's native type-stripping with a fake `fetch`;
 * api.ts has no browser-only imports.
 * Run: node --test web/src/lib/api.test.mjs
 * ------------------------------------------------------------------ */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { promptAgent, queueAgent, sendErrorText } from './api.ts'

// Each entry is one canned response, consumed in order. Reports to the
// client-send-fail endpoint are collected apart (`beacons`) and never consume one.
let calls = []
let replies = []
let beacons = []
let beaconDown = false
const reply = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  json: async () => body,
})
// What an EDGE answers with: not JSON at all.
const html = (status, headers = {}) => ({
  ok: false,
  status,
  headers: new Headers(headers),
  json: async () => { throw new SyntaxError('Unexpected token < in JSON') },
})
const fakeFetch = async (url, init) => {
  if (url.endsWith('/agents/client-send-fail')) {
    if (beaconDown) throw new Error('offline')
    beacons.push(...JSON.parse(init.body).reports)
    return reply(200, { ok: true })
  }
  calls.push({ url, body: JSON.parse(init.body) })
  const next = replies.shift()
  assert.ok(next, `unexpected extra fetch to ${url}`)
  return next
}
beforeEach(() => {
  globalThis.fetch = fakeFetch
  calls = []
  replies = []
  beacons = []
  beaconDown = false
})

const BODY = { id: 'kb-how-do-i-move-this-config', text: 'and what comes next?' }
const NOT_DELIVERED = { ok: false, error: 'input did not land in the session (not submitted)', notDelivered: true }

test('a proven non-delivery is retried exactly once, and the retry’s success is the answer', async () => {
  replies = [reply(502, NOT_DELIVERED), reply(200, { ok: true })]
  const r = await promptAgent(BODY)
  assert.equal(r.ok, true)
  assert.equal(calls.length, 2, 'one retry, not zero and not a loop')
  assert.deepEqual(calls[0].body, calls[1].body, 'the retry must re-send the IDENTICAL payload')
  assert.match(calls[1].url, /\/api\/agents\/prompt$/)
})

test('a second failure is surfaced once — no third attempt', async () => {
  replies = [reply(502, NOT_DELIVERED), reply(502, NOT_DELIVERED)]
  const r = await promptAgent(BODY)
  assert.equal(r.ok, false)
  assert.equal(r.error, 'input did not land in the session (not submitted)')
  assert.equal(calls.length, 2)
})

test('409 `menu` is NEVER retried — the card has to render the menu instead', async () => {
  replies = [reply(409, { ok: false, error: 'menu', menuKind: 'choice' })]
  const r = await promptAgent(BODY)
  assert.equal(calls.length, 1)
  assert.equal(r.error, 'menu', "AgentList keys its 'dismiss menu (Esc) & send' off this")
  assert.equal(r.menuKind, 'choice', 'the failure body must survive agentPost')
})

test('a 502 WITHOUT the proof is not retried (a transport failure may already have landed)', async () => {
  replies = [reply(502, { ok: false, error: 'bridge unreachable' })]
  const r = await promptAgent(BODY)
  assert.equal(calls.length, 1, 'retrying this could double-send')
  assert.equal(r.error, 'bridge unreachable')
  assert.equal(r.status, 502)
})

test('4xx and 5xx that are not a proven non-delivery pass straight through', async () => {
  for (const [status, body] of [[401, { error: 'unauthorized' }], [404, { error: 'no such session' }], [500, { error: 'boom' }]]) {
    calls = []
    replies = [reply(status, { ok: false, ...body })]
    const r = await promptAgent(BODY)
    assert.equal(calls.length, 1, `HTTP ${status} must not be retried`)
    assert.equal(r.ok, false)
  }
})

test('a network error is returned, not retried', async () => {
  globalThis.fetch = async () => {
    calls.push({ url: 'throw' })
    throw new Error('offline')
  }
  const r = await promptAgent(BODY)
  assert.equal(r.ok, false)
  assert.equal(calls.length, 1)
})

/* ── The 502s nobody could see ───────────────────────────────────────────────
 * "502 on send, then it works again shortly after" — with no 5xx in the API's
 * own logs. Those are answered in FRONT of our API (a Cloudflare tunnel's HTML
 * 502/524, a login page, a reverse proxy's empty upstream-down body) and were
 * invisible. The client
 * is the only place that sees them: it classifies them apart from a delivery
 * failure, and reports their shape to audit.log once the API answers again.
 */
const flush = () => new Promise((r) => setTimeout(r, 0))
// Reports are held module-wide until an answer proves the API reachable — so
// start each of these from an empty backlog (earlier tests leave failures in it).
const drain = async () => {
  replies = [reply(200, { ok: true })]
  await queueAgent(BODY)
  await flush()
  calls = []
  beacons = []
}

test('a Cloudflare HTML 502 is `unreachable`, never retried, and carries the ray id', async () => {
  replies = [html(502, { 'cf-ray': '8c1d2e3f4a5b6c7d-FRA' })]
  const r = await promptAgent(BODY)
  assert.equal(calls.length, 1, 'no proof of non-delivery — must not retry')
  assert.equal(r.unreachable, true)
  assert.equal(r.status, 502)
  assert.equal(r.cfRay, '8c1d2e3f4a5b6c7d-FRA')
  assert.ok(!r.notDelivered)
})

test('the edge failure is reported with its shape — and only once the API answers again', async () => {
  await drain()
  replies = [html(524, { 'cf-ray': 'abc123def4567890-FRA' })]
  await promptAgent(BODY)
  await flush()
  assert.equal(beacons.length, 0, 'held until the API is provably reachable')
  replies = [reply(200, { ok: true })]
  await queueAgent(BODY)
  await flush()
  assert.equal(beacons.length, 1)
  const b = beacons[0]
  assert.equal(b.op, 'prompt')
  assert.equal(b.kind, 'non-json')
  assert.equal(b.status, 524)
  assert.equal(b.cfRay, 'abc123def4567890-FRA')
  assert.equal(b.len, BODY.text.length)
  assert.equal(typeof b.ms, 'number')
  assert.ok(!JSON.stringify(b).includes(BODY.text), 'the text itself never leaves in a report')
})

test('a network error is reported as such, and a failed report is kept for the next try', async () => {
  await drain()
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
  const r = await promptAgent(BODY)
  assert.equal(r.unreachable, true)
  globalThis.fetch = fakeFetch
  beaconDown = true
  replies = [reply(200, { ok: true })]
  await queueAgent(BODY)
  await flush()
  assert.equal(beacons.length, 0)
  beaconDown = false
  replies = [reply(200, { ok: true })]
  await queueAgent(BODY)
  await flush()
  assert.equal(beacons.length, 1)
  assert.equal(beacons[0].kind, 'network')
})

test('our own JSON 502 is NOT an edge failure — no report', async () => {
  await drain()
  replies = [reply(502, { ok: false, error: 'bridge unreachable' }), reply(200, { ok: true })]
  await promptAgent(BODY)
  await queueAgent(BODY)
  await flush()
  assert.equal(beacons.length, 0)
})

test('sendErrorText names the failure class instead of a bare "502"', () => {
  assert.match(sendErrorText({ ok: false, status: 502, notDelivered: true, error: 'input did not land in the session (not submitted)' }), /not delivered.*nothing was sent.*send again/i)
  assert.match(sendErrorText({ ok: false, unreachable: true, status: 502, cfRay: '8c1d-FRA', error: 'HTTP 502' }), /not reachable \(HTTP 502 from the edge, ray 8c1d-FRA\).*may not have arrived/)
  assert.match(sendErrorText({ ok: false, unreachable: true, error: 'TypeError: Failed to fetch' }), /not reachable \(network error\)/)
  assert.match(sendErrorText({ ok: false, error: 'menu', status: 409 }), /choice menu/)
  // The holds: each says nothing was typed, and a draft the operator may own
  // is said to be left alone.
  assert.match(sendErrorText({ ok: false, error: 'panel', status: 409 }), /panel is open.*nothing was typed.*Dismiss/)
  assert.match(sendErrorText({ ok: false, error: 'box-not-empty', status: 409, boxChars: 694 }), /already holds unsent text \(694 characters\).*left alone/)
  assert.match(sendErrorText({ ok: false, error: 'no-box', status: 409 }), /not on screen.*nothing was typed/)
  assert.equal(sendErrorText({ ok: false, status: 404, error: 'no such session' }), 'no such session')
  assert.equal(sendErrorText({ ok: false }, 'queue'), 'queue failed')
})
