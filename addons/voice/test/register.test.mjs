/* ------------------------------------------------------------------ *
 * The addon's registration surface: the three routes, on a real Express app, and
 * the manifest core reads.
 *
 * What this pins:
 *   · ALL THREE ROUTES GATE THEMSELVES. Addon routers are mounted without core's
 *     bearer middleware and every route here spends something — a `claude -p`
 *     call, or CPU on an engine — so an unauthenticated POST must never reach
 *     the spend, and a server with no token configured must refuse rather than
 *     fall open;
 *   · a bad event / an empty tail is a 400, not a model call;
 *   · with no on-box engine, /speak and /transcribe are a 503 CARRYING THE
 *     REASON — the browser path is the default and the card has to be able to
 *     say why the box one did not run;
 *   · the manifest declares ONLY routes + status: no cron, no search leg, no
 *     evidence leg, no scorecard tiles, i.e. nothing that would change a core
 *     answer while the addon is merely enabled (the zero-cost invariant).
 *
 * Hermetic: `claude` and the engines are shell stubs on a temp PATH; the app
 * listens on an OS-assigned port on loopback.
 * Run: node --test addons/voice/test/register.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

/* The addon takes `express`/`Router` from the loader (docs/ADDONS.md), so the
 * test plays loader: it resolves express out of core's tree once and hands the
 * same pair in. */
const express = createRequire(new URL('../../../api/src/', import.meta.url))('express')
const deps = { name: 'voice', dir: '', repoRoot: '', express, Router: (o) => express.Router(o) }

const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-voice-reg-'))
const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
stub('claude', 'cat > /dev/null; echo "The agent finished the refactor and is waiting for review."')
stub('say-stub', "printf 'RIFFAUDIO'; cat > /dev/null")
stub('hear-stub', 'cat > /dev/null; echo "spoken words"')

const TOKEN = 'test-token-abc'
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH || ''}`
// Pin the stub as THE binary, not merely the first `claude` on PATH: the API
// resolves an absolute path once (api/src/claude-bin.mjs) and CLAUDE_BIN is its
// authoritative input, so an operator's own CLAUDE_BIN can't reach this test.
process.env.CLAUDE_BIN = path.join(bin, 'claude')
process.env.DASHBOARD_BEARER_TOKEN = TOKEN
process.env.ATLAS_VOICE_TTS_CMD = ''
process.env.ATLAS_VOICE_STT_CMD = ''
process.env.ATLAS_VOICE_MIN_INTERVAL_MS = '60000'
process.env.ATLAS_VOICE_DAILY_BUDGET = '50'

const registerAddon = (await import('../api/register.mjs')).default
const manifest = registerAddon(deps)

const app = express()
app.use(manifest.routes)
const server = await new Promise((res) => {
  const s = app.listen(0, '127.0.0.1', () => res(s))
})
const base = `http://127.0.0.1:${server.address().port}`
after(() => {
  server.close()
  fs.rmSync(bin, { recursive: true, force: true })
})

const post = (p, { body, token, type = 'application/json' } = {}) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body ?? {}),
  })

test('every route refuses without the bearer — none of them may be reachable open', async () => {
  const bodies = {
    '/api/voice/recap': { agentId: 'a1', event: 'turn-end', tail: 'some output' },
    '/api/voice/speak': { text: 'hello' },
    '/api/voice/transcribe': { anything: true },
  }
  for (const [route, body] of Object.entries(bodies)) {
    assert.equal((await post(route, { body })).status, 401, `${route} without a token`)
    assert.equal((await post(route, { body, token: 'wrong-token-xy' })).status, 401, `${route} with a wrong token`)
  }
})

test('a server with no token configured refuses rather than falling open', async () => {
  delete process.env.DASHBOARD_BEARER_TOKEN
  const res = await post('/api/voice/recap', { body: { tail: 'x' }, token: TOKEN })
  assert.equal(res.status, 500)
  assert.match((await res.json()).error, /DASHBOARD_BEARER_TOKEN/)
  process.env.DASHBOARD_BEARER_TOKEN = TOKEN
})

test('recap: an authorized call reaches claude -p; a malformed one never does', async () => {
  const bad = await post('/api/voice/recap', { body: { event: 'sing-a-song', tail: 'x' }, token: TOKEN })
  assert.equal(bad.status, 400)
  assert.match((await bad.json()).error, /unknown event/)

  const empty = await post('/api/voice/recap', { body: { event: 'turn-end', tail: '   ' }, token: TOKEN })
  assert.equal(empty.status, 400)

  const ok = await post('/api/voice/recap', { body: { agentId: 'a1', agent: 'refactor', event: 'turn-end', tail: 'ran the tests' }, token: TOKEN })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { ok: true, text: 'The agent finished the refactor and is waiting for review.' })

  // The guard answers 200 with a reason — a skip is a normal outcome, not a fault.
  const again = await post('/api/voice/recap', { body: { agentId: 'a1', event: 'turn-end', tail: 'ran the tests' }, token: TOKEN })
  assert.deepEqual(await again.json(), { ok: false, skipped: 'unchanged-tail' })
})

test('with no on-box engine, speak/transcribe are a 503 carrying the reason', async () => {
  const spoken = await post('/api/voice/speak', { body: { text: 'hello' }, token: TOKEN })
  assert.equal(spoken.status, 503)
  assert.match((await spoken.json()).error, /browser/i)

  const heard = await post('/api/voice/transcribe', { body: Buffer.from('fake audio'), token: TOKEN, type: 'audio/webm' })
  assert.equal(heard.status, 503)
  assert.match((await heard.json()).error, /ATLAS_VOICE_STT_CMD/)

  assert.equal((await post('/api/voice/speak', { body: { text: '  ' }, token: TOKEN })).status, 400)
})

test('with an engine configured, audio goes out as bytes and a clip comes back as text', async () => {
  process.env.ATLAS_VOICE_TTS_CMD = 'say-stub'
  process.env.ATLAS_VOICE_TTS_MIME = 'audio/wav'
  process.env.ATLAS_VOICE_STT_CMD = 'hear-stub'

  const spoken = await post('/api/voice/speak', { body: { text: 'hello' }, token: TOKEN })
  assert.equal(spoken.status, 200)
  assert.match(spoken.headers.get('content-type') || '', /audio\/wav/)
  assert.equal(Buffer.from(await spoken.arrayBuffer()).toString(), 'RIFFAUDIO')

  const heard = await post('/api/voice/transcribe', { body: Buffer.from('fake audio'), token: TOKEN, type: 'audio/webm' })
  assert.deepEqual(await heard.json(), { ok: true, text: 'spoken words' })

  process.env.ATLAS_VOICE_TTS_CMD = ''
  process.env.ATLAS_VOICE_STT_CMD = ''
})

test('the manifest declares routes + status and NOTHING that touches a core answer', () => {
  assert.deepEqual(Object.keys(manifest).sort(), ['description', 'routes', 'status'])
  assert.ok(manifest.description.length > 20)

  const st = manifest.status()
  assert.match(st.speech, /browser/i, 'the zero-install default is the browser')
  assert.match(st.dictation, /browser/i)
  assert.equal(st.tts.configured, false)
  assert.equal(st.stt.configured, false)
  assert.equal(st.recap.budget, 50)
  assert.match(st.recap.guards, /per agent/)
  assert.match(st.bearer, /Caddyfile/)

  // A status hook must never throw into GET /api/addons, whatever the env says.
  process.env.ATLAS_VOICE_TTS_CMD = 'not-installed-anywhere'
  assert.equal(registerAddon(deps).status().tts.available, false)
  process.env.ATLAS_VOICE_TTS_CMD = ''
})
