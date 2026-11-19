/* ------------------------------------------------------------------ *
 * Tests for the access-session helpers in api.ts — isAuthBounce,
 * probeSession, relogin — behind SessionExpiredBanner.
 *
 * With an expired session in front of the dashboard (Cloudflare Access or any
 * other auth proxy), every API call bounces to a login page the cards cannot
 * show and the app reads as dead. One probe decides whether to say so, and the
 * banner's button is a top-level navigation the proxy can answer with its
 * login. Pinned: what counts as a bounce (and that a 5xx or 404 does not), that
 * the probe never follows the redirect, that offline is not "expired", and
 * that re-login navigates.
 *
 * Runs the real module via node's native type-stripping with a fake `fetch`
 * and a fake `window.location`, like api.test.mjs.
 * Run: node --test web/src/lib/session.test.mjs
 * ------------------------------------------------------------------ */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { isAuthBounce, probeSession, relogin } from './api.ts'

let calls = []
let next = null // a response object, or an Error to throw
const res = (status, { type = 'basic' } = {}) => ({ ok: status >= 200 && status < 300, status, type, json: async () => ({}) })
beforeEach(() => {
  calls = []
  next = null
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (next instanceof Error) throw next
    return next
  }
})

test('isAuthBounce: opaque redirect, status 0, 401, 403 are the login bounce; nothing else is', () => {
  assert.equal(isAuthBounce({ type: 'opaqueredirect', status: 0 }), true)
  assert.equal(isAuthBounce({ type: 'basic', status: 0 }), true)
  assert.equal(isAuthBounce({ type: 'basic', status: 401 }), true)
  assert.equal(isAuthBounce({ type: 'basic', status: 403 }), true)
  for (const status of [200, 204, 404, 500, 502, 503]) {
    assert.equal(isAuthBounce({ type: 'basic', status }), false, `status ${status}`)
  }
})

test('probeSession: a login redirect is "expired", and the probe never follows it', async () => {
  next = res(0, { type: 'opaqueredirect' })
  assert.equal(await probeSession(), 'expired')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/health')
  assert.equal(calls[0].init.redirect, 'manual')
  assert.equal(calls[0].init.cache, 'no-store')
  next = res(401)
  assert.equal(await probeSession(), 'expired')
  next = res(403)
  assert.equal(await probeSession(), 'expired')
})

test('probeSession: a thrown fetch is "offline" (no banner), any other answer is "ok"', async () => {
  next = new TypeError('Failed to fetch')
  assert.equal(await probeSession(), 'offline')
  next = res(200)
  assert.equal(await probeSession(), 'ok')
  // The session is fine; the API isn't — not a reason to send anyone to a login.
  next = res(502)
  assert.equal(await probeSession(), 'ok')
  next = res(404)
  assert.equal(await probeSession(), 'ok')
})

test('relogin: a top-level navigation the proxy in front can answer with its login', () => {
  const nav = []
  globalThis.window = { location: { assign: (u) => nav.push(['assign', u]), reload: () => nav.push(['reload']) } }
  try {
    relogin()
  } finally {
    delete globalThis.window
  }
  assert.deepEqual(nav, [['reload']])
})
