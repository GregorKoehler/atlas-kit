/* ------------------------------------------------------------------ *
 * Guards POST /api/agents/client-send-fail — the server half of making the
 * INVISIBLE chat-send 502s measurable.
 *
 * A send can fail in the browser without the API ever answering it: a 502 or
 * 524 from the edge in front of it (a Cloudflare tunnel, a reverse proxy
 * whose upstream is restarting), or a network error. None of those reach the
 * API's own audit.log, so edge failures and delivery failures were
 * indistinguishable. The web client now reports a send that never got a
 * JSON answer (web/src/lib/api.ts reportSendFailure); this route appends it to
 * audit.log as `action: client-send-fail`.
 *
 * What is pinned: it is bearer-gated, it records ONLY whitelisted, bounded
 * fields (a client cannot write arbitrary keys, or the operator's text, into
 * the audit trail), and a batch is capped.
 *
 * AGENT_LOCAL_DIR sandboxes agent-local.mjs's audit.log, same convention as
 * agent-routes-bridge-status.test.mjs.
 * Run: node --test api/test/client-send-fail.test.mjs
 * ------------------------------------------------------------------ */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.AGENT_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-client-send-fail-'))
process.env.AGENT_LOCAL_RECONCILE = '0'
const AUDIT = path.join(process.env.AGENT_LOCAL_DIR, 'audit.log')

const { agentRouter, clientSendFailEntry } = await import('../src/agent-routes.mjs')

let server, base
before(async () => {
  const app = express()
  app.use(express.json())
  const bearer = (req, res, next) => (req.get('authorization') === 'Bearer t' ? next() : res.status(401).json({ ok: false, error: 'unauthorized' }))
  app.use(agentRouter(bearer))
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r) })
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

const post = (body, auth = 'Bearer t') =>
  fetch(`${base}/api/agents/client-send-fail`, { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: auth }, body: JSON.stringify(body) })
const audited = () => (fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  .filter((e) => e.action === 'client-send-fail')

test('a report is audited with its shape: op, kind, status, cf-ray, timing, length', async () => {
  const r = await post({ reports: [{ op: 'prompt', kind: 'non-json', status: 502, cfRay: '8c1d2e3f4a5b6c7d-FRA', ms: 312, len: 211, at: '2026-10-02T12:12:24.292Z' }] })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).recorded, 1)
  const e = audited().at(-1)
  assert.deepEqual(
    { op: e.op, kind: e.kind, status: e.status, cfRay: e.cfRay, ms: e.ms, len: e.len, sentAt: e.sentAt, ok: e.ok },
    { op: 'prompt', kind: 'non-json', status: 502, cfRay: '8c1d2e3f4a5b6c7d-FRA', ms: 312, len: 211, sentAt: '2026-10-02T12:12:24.292Z', ok: false },
  )
})

test('it is bearer-gated', async () => {
  const before = audited().length
  const r = await post({ op: 'prompt', kind: 'network' }, 'Bearer nope')
  assert.equal(r.status, 401)
  assert.equal(audited().length, before)
})

test('only whitelisted fields survive — no text, no arbitrary keys, no junk values', () => {
  const e = clientSendFailEntry({ op: 'prompt', kind: 'network', text: 'secret words', action: 'spawn', status: 'x', cfRay: '<script>', ms: -1, peer: 'some-peer' })
  assert.deepEqual(e, { action: 'client-send-fail', op: 'prompt', kind: 'network', ok: false })
  assert.equal(clientSendFailEntry({ op: 'kill' }), null, 'only the three sends are reportable')
  assert.equal(clientSendFailEntry(null), null)
})

test('a batch is capped at 20 and invalid entries are skipped', async () => {
  const before = audited().length
  const reports = [...Array.from({ length: 25 }, () => ({ op: 'queue', kind: 'network' })), { op: 'bogus' }]
  const r = await post({ reports })
  assert.equal((await r.json()).recorded, 20)
  assert.equal(audited().length, before + 20)
})
