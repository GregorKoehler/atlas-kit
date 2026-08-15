/* ------------------------------------------------------------------ *
 * The HTTP MCP server must FAIL CLOSED.
 *
 * The gate it used to have was `if (!CF_TEAM || !CF_AUD) return next()`. Follow
 * docs/SETUP.md and this endpoint ends up PUBLICLY ROUTED — the cloudflared
 * template routes mcp.<your-domain> → http://localhost:3002 — so clearing
 * either CF_ACCESS_* value silently republishes the whole knowledge base with no
 * auth and no error. Emptying an env value is not a code-review event, and none
 * of it is visible in a diff.
 *
 * So this asserts the invariant end to end, against the REAL process (spawned,
 * with a curated env) rather than the policy module alone:
 *   1. non-loopback bind + unconfigured Access  → exits non-zero, loudly
 *   2. half-configured counts as unconfigured   → same refusal
 *   3. a TUNNEL INGRESS rule for our port with the gate off → same refusal, even on
 *      a 127.0.0.1 bind (cloudflared dials its origin over loopback, so a
 *      bind-only check would pass on exactly the setup the docs tell you to build)
 *   4. loopback + unconfigured + no ingress     → serves, but WARNS every start
 *   5. the default tool surface is the 7 read tools, and the agent-control tools
 *      can NEVER appear here — not even with ATLAS_AGENT_CONTROL=1 in the env
 *   6. configured                               → no JWT = 401, bad JWT = 403
 *
 * Hermetic: temp cloudflared configs, ports picked from the OS, a `.invalid`
 * Access team domain so no JWKS fetch can ever succeed. No vault, no network.
 *
 * Run: node --test api/test/mcp-http-fail-closed.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  accessPolicy, accessPrincipal, cleanEnv, isLoopbackBind, tunnelHostnamesForPort, toolSurface,
} from '../src/mcp/http-policy.mjs'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ENTRY = path.join(HERE, '..', 'src', 'mcp', 'http.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-mcp-http-'))

/** A cloudflared config routing `hostname` to `port`, shaped like the kit's template. */
function tunnelConfig(hostname, port, name = `cf-${port}.yml`) {
  const file = path.join(TMP, name)
  fs.writeFileSync(
    file,
    `tunnel: 00000000-0000-0000-0000-000000000000\ncredentials-file: /etc/cloudflared/creds.json\n\ningress:\n` +
      `  - hostname: dashboard.example.com\n    service: http://localhost:8080\n` +
      `  - hostname: ${hostname}\n    service: http://localhost:${port}\n` +
      `  - service: http_status:404\n`,
  )
  return file
}
/** …and one that routes nothing to us (the "no local tunnel" case). */
const emptyTunnelConfig = () => tunnelConfig('dashboard.example.com', 8080, 'cf-none.yml')

/* ---- the pure policy core ----------------------------------------- */

test('present-but-empty env is treated exactly as unset', () => {
  assert.equal(cleanEnv(''), '')
  assert.equal(cleanEnv('  '), '')
  assert.equal(cleanEnv(undefined), '')
  // The trap: `KEY=` in .env leaves the key defined, so a truthiness check on the
  // value is the difference between a gate and an open door.
  const p = accessPolicy({ bind: '0.0.0.0', team: '', aud: '' })
  assert.equal(p.ok, false)
  const q = accessPolicy({ bind: '127.0.0.1', team: '   ', aud: '\t' })
  assert.equal(q.enforced, false)
})

test('loopback detection covers 127/8, ::1 and localhost — nothing else', () => {
  for (const b of ['', '127.0.0.1', '127.0.0.53', 'localhost', '::1', '[::1]', 'LOCALHOST'])
    assert.equal(isLoopbackBind(b), true, `${b} should be loopback`)
  for (const b of ['0.0.0.0', '::', '100.64.1.2', '10.0.0.5', 'mcp.example.com', '128.0.0.1'])
    assert.equal(isLoopbackBind(b), false, `${b} must NOT count as loopback`)
})

test('reachable bind + unconfigured Access is a refusal, not a warning', () => {
  const p = accessPolicy({ bind: '0.0.0.0', team: '', aud: '' })
  assert.equal(p.ok, false)
  assert.match(p.message, /REFUSING TO START/)
  assert.match(p.message, /0\.0\.0\.0/)
})

test('half-configured Access is unconfigured (no partial gate)', () => {
  assert.equal(accessPolicy({ bind: '0.0.0.0', team: 'x.cloudflareaccess.com', aud: '' }).ok, false)
  assert.equal(accessPolicy({ bind: '0.0.0.0', team: '', aud: 'abc' }).ok, false)
  const loop = accessPolicy({ bind: '127.0.0.1', team: 'x.cloudflareaccess.com', aud: '' })
  assert.equal(loop.ok, true)
  assert.equal(loop.enforced, false)
  assert.match(loop.warnings.join(' '), /half-set/)
})

test('loopback + unconfigured serves but is never silent; configured enforces', () => {
  const open = accessPolicy({ bind: '127.0.0.1', team: '', aud: '' })
  assert.equal(open.ok, true)
  assert.equal(open.enforced, false)
  assert.match(open.warnings.join(' '), /UNAUTHENTICATED/)

  const gated = accessPolicy({ bind: '127.0.0.1', team: 'x.cloudflareaccess.com', aud: 'aud1' })
  assert.equal(gated.enforced, true)
  assert.deepEqual(gated.warnings, [])

  // Configured AND reachable is allowed — but the JWT alone is not sufficient, so
  // the operator's half (the origin must be unreachable except via Access) is stated.
  const remote = accessPolicy({ bind: '0.0.0.0', team: 'x.cloudflareaccess.com', aud: 'aud1' })
  assert.equal(remote.ok, true)
  assert.equal(remote.enforced, true)
  assert.match(remote.warnings.join(' '), /necessary but NOT sufficient/)
})

test('a tunnel ingress rule makes a loopback bind reachable — and unconfigured fatal', () => {
  const tunnel = { file: '/etc/cloudflared/config.yml', hostnames: ['mcp.example.com'] }
  const fatal = accessPolicy({ bind: '127.0.0.1', team: '', aud: '', tunnel })
  assert.equal(fatal.ok, false, 'a routed port with the gate off must refuse to start')
  assert.match(fatal.message, /REFUSING TO START/)
  assert.match(fatal.message, /mcp\.example\.com/)
  assert.match(fatal.message, /a 127\.0\.0\.1 bind does NOT make it unreachable/)

  // Configured: allowed, but the "Access must be the ONLY way in" warning stands.
  const gated = accessPolicy({ bind: '127.0.0.1', team: 'x.cloudflareaccess.com', aud: 'aud1', tunnel })
  assert.equal(gated.ok, true)
  assert.equal(gated.enforced, true)
  assert.match(gated.warnings.join(' '), /reachable from outside loopback/)
})

test('ingress parsing keys off the PORT, however the origin is named', () => {
  const cfg = (svc) => `ingress:\n  - hostname: mcp.example.com\n    service: ${svc}\n  - service: http_status:404\n`
  for (const svc of ['http://localhost:3002', 'http://127.0.0.1:3002', 'http://10.0.0.5:3002/'])
    assert.deepEqual(tunnelHostnamesForPort(cfg(svc), 3002), ['mcp.example.com'], svc)
  assert.deepEqual(tunnelHostnamesForPort(cfg('http://localhost:8080'), 3002), [])
  assert.deepEqual(tunnelHostnamesForPort(cfg('http_status:404'), 3002), []) // non-URL services
  assert.deepEqual(tunnelHostnamesForPort('', 3002), [])
  assert.deepEqual(tunnelHostnamesForPort('%%% not yaml [', 3002), []) // unparseable ≠ crash
  // A catch-all rule (no hostname) still counts as routed.
  assert.deepEqual(tunnelHostnamesForPort('ingress:\n  - service: http://localhost:3002\n', 3002), ['(catch-all)'])
})

test('the tool surface is narrow by default; only an exact `broad` widens it', () => {
  assert.equal(toolSurface({}), 'knowledge')
  assert.equal(toolSurface({ ATLAS_MCP_HTTP_SURFACE: '' }), 'knowledge')
  assert.equal(toolSurface({ ATLAS_MCP_HTTP_SURFACE: '1' }), 'knowledge') // a typo must not widen
  assert.equal(toolSurface({ ATLAS_MCP_HTTP_SURFACE: 'full' }), 'knowledge')
  assert.equal(toolSurface({ ATLAS_MCP_HTTP_SURFACE: ' BROAD ' }), 'broad')
})

test('a service-token JWT identifies by common_name, an IdP one by email', () => {
  // Cloudflare's documented payloads: IdP → email + sub + identity_nonce;
  // service token → common_name "<client-id>.access", sub "", NO email.
  assert.deepEqual(accessPrincipal({ email: 'a@b.c', sub: 'uuid' }), { kind: 'user', id: 'a@b.c', email: 'a@b.c' })
  const svc = accessPrincipal({ type: 'app', sub: '', common_name: 'e367826f.access' })
  assert.equal(svc.kind, 'service')
  assert.equal(svc.id, 'service:e367826f.access')
  assert.equal(svc.email, undefined)
  // Verified but nameless → rejected upstream, never served as anonymous.
  assert.equal(accessPrincipal({ type: 'app', sub: '' }), null)
  assert.equal(accessPrincipal({ email: '' }), null)
  assert.equal(accessPrincipal(undefined), null)
})

/* ---- the real process -------------------------------------------- */

// CLOUDFLARED_CONFIG is pinned so a spawned server never reads a REAL tunnel config
// that might route this port — each case states its own ingress explicitly.
const BASE_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_PATH: '',
  CLOUDFLARED_CONFIG: emptyTunnelConfig(),
}

function run(env) {
  const child = spawn(process.execPath, [ENTRY], { env: { ...BASE_ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const out = { text: '', closed: false, code: null }
  child.stdout.on('data', (d) => (out.text += d))
  child.stderr.on('data', (d) => (out.text += d))
  // `close` (not `exit`): it fires once the stdio pipes are drained too, so from
  // here on `out.text` is the WHOLE output and nothing can still be in flight.
  child.on('close', (code) => ((out.closed = true), (out.code = code)))
  return { child, out }
}

/**
 * Wait until `re` appears in the child's output.
 *
 * ⚠️ The server prints its listening line and its WARNING lines as SEPARATE
 * console.error writes, which arrive as separate chunks on the pipe. Matching the
 * first one says nothing about the rest having landed — under load the second
 * chunk arrives after the assertion. So every assertion on child output waits for
 * the output it actually depends on; a bare `assert.match(out.text, …)` here is a
 * load-dependent race, and a fixed settle-delay only hides it.
 */
async function waitFor(out, re, ms = 15000) {
  const deadline = Date.now() + ms
  while (!re.test(out.text)) {
    if (out.closed) throw new Error(`process ended (${out.code}) without matching ${re}: ${out.text}`)
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${re}: ${out.text}`)
    await new Promise((r) => setTimeout(r, 20))
  }
  return out.text
}

/** Resolve with the exit code, or reject if it is still up after `ms`. */
const exited = (child, ms = 15000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => (child.kill('SIGKILL'), reject(new Error('did not exit'))), ms)
    // Same reason as `close` above: `exit` alone can precede the last chunk, and
    // these tests assert on the refusal text the dying process just printed.
    child.on('close', (code) => (clearTimeout(t), resolve(code)))
  })

/** A free port, reserved then released — MCP_PORT=0 would hide the real one. */
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

/** Spawn on a free loopback port and wait for the listening line. */
async function serving(env) {
  const port = await freePort()
  const { child, out } = run({ MCP_BIND: '127.0.0.1', MCP_PORT: String(port), ...env })
  await waitFor(out, /HTTP on http:\/\//)
  return { child, out, port, url: `http://127.0.0.1:${port}` }
}

async function toolNames(url) {
  const client = new Client({ name: 'mcp-http-fail-closed-test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)))
  const { tools } = await client.listTools()
  await client.close()
  return tools.map((t) => t.name).sort()
}

const READ_TOOLS = ['get_note', 'query_atlas', 'query_vault', 'recent_activity', 'wiki_graph', 'wiki_index', 'wiki_pages']

test('non-loopback bind + unconfigured Access → refuses to start, non-zero', async () => {
  // The catastrophic edit: widen the bind while the gate is off.
  const { child, out } = run({ MCP_BIND: '0.0.0.0', MCP_PORT: '0', CF_ACCESS_TEAM_DOMAIN: '', CF_ACCESS_AUD: '' })
  assert.notEqual(await exited(child), 0)
  assert.match(out.text, /REFUSING TO START/)
  assert.match(out.text, /the origin would then verify NOTHING/i)
})

test('non-loopback bind + HALF-configured Access → also refuses', async () => {
  const { child, out } = run({
    MCP_BIND: '0.0.0.0',
    MCP_PORT: '0',
    CF_ACCESS_TEAM_DOMAIN: 'atlas-kit-test.cloudflareaccess.invalid',
    CF_ACCESS_AUD: '  ',
  })
  assert.notEqual(await exited(child), 0)
  assert.match(out.text, /REFUSING TO START/)
})

test('a live tunnel ingress for our port + unconfigured → refuses, on a loopback bind', async () => {
  // The documented setup with the gate cleared: MCP_BIND=127.0.0.1 (looks safe),
  // while mcp.<domain> → http://localhost:3002 in the cloudflared config (isn't).
  const port = await freePort()
  const { child, out } = run({
    MCP_BIND: '127.0.0.1',
    MCP_PORT: String(port),
    CF_ACCESS_TEAM_DOMAIN: '',
    CF_ACCESS_AUD: '',
    CLOUDFLARED_CONFIG: tunnelConfig('mcp.example.com', port),
  })
  assert.notEqual(await exited(child), 0)
  assert.match(out.text, /REFUSING TO START/)
  assert.match(out.text, /mcp\.example\.com/)
})

test('the same ingress with Access configured starts (and still warns)', async () => {
  const port = await freePort()
  const { child, out } = run({
    MCP_BIND: '127.0.0.1',
    MCP_PORT: String(port),
    CF_ACCESS_TEAM_DOMAIN: 'atlas-kit-test.cloudflareaccess.invalid',
    CF_ACCESS_AUD: 'aud-tag-for-test',
    CLOUDFLARED_CONFIG: tunnelConfig('mcp.example.com', port),
  })
  try {
    await waitFor(out, /Access JWT check: ENFORCED/)
    await waitFor(out, /WARNING: .*reachable from outside loopback/)
  } finally {
    child.kill('SIGKILL')
  }
})

test('loopback + unconfigured → serves, and says the gate is INACTIVE', async () => {
  const s = await serving({ CF_ACCESS_TEAM_DOMAIN: '', CF_ACCESS_AUD: '' })
  try {
    await waitFor(s.out, /Access JWT check: INACTIVE/)
    await waitFor(s.out, /WARNING: .*UNAUTHENTICATED/)
    const health = await fetch(`${s.url}/health`)
    assert.equal(health.status, 200)
    assert.equal((await health.json()).ok, true)
  } finally {
    s.child.kill('SIGKILL')
  }
})

test('the endpoint serves the KNOWLEDGE-ONLY surface by default', async () => {
  const s = await serving({})
  try {
    await waitFor(s.out, /tools: knowledge-only/)
    assert.deepEqual(await toolNames(s.url), READ_TOOLS)
  } finally {
    s.child.kill('SIGKILL')
  }
})

test('ATLAS_AGENT_CONTROL in the env can NEVER put agent control on this endpoint', async () => {
  // The whole point of fail-closed: the remote connector is reads over the vault.
  // Setting the orchestrator's own flag in the MCP service env (a plausible
  // copy-paste from control.mcp.json) must not publish spawn/prompt/kill.
  const s = await serving({ ATLAS_AGENT_CONTROL: '1' })
  try {
    const names = await toolNames(s.url)
    assert.deepEqual(names, READ_TOOLS)
    for (const t of ['spawn_agent', 'prompt_agent', 'kill_agent', 'cleanup_agent', 'interrupt_agent'])
      assert.ok(!names.includes(t), `${t} must never register on the HTTP endpoint`)
  } finally {
    s.child.kill('SIGKILL')
  }
})

test('…and not even ATLAS_MCP_HTTP_SURFACE=broad reaches agent control', async () => {
  const s = await serving({ ATLAS_MCP_HTTP_SURFACE: 'broad', ATLAS_AGENT_CONTROL: '1' })
  try {
    await waitFor(s.out, /WARNING: ATLAS_MCP_HTTP_SURFACE=broad/)
    const names = await toolNames(s.url)
    assert.ok(!names.includes('spawn_agent'), 'agent control must never register here')
    // Today the kit's non-control surface IS the seven reads, so `broad` widens
    // nothing yet — the knob exists so a tool added later cannot land here by
    // default. If this assertion starts failing because a new non-control tool
    // was added, widen it to a superset check rather than deleting it.
    assert.deepEqual(names, READ_TOOLS)
  } finally {
    s.child.kill('SIGKILL')
  }
})

test('configured → a request with no JWT is 401 and a bad JWT is 403', async () => {
  // A .invalid team domain: the JWKS fetch can never succeed, so a forged token
  // cannot verify. Both branches must reject BEFORE any MCP handling.
  const s = await serving({
    CF_ACCESS_TEAM_DOMAIN: 'atlas-kit-test.cloudflareaccess.invalid',
    CF_ACCESS_AUD: 'aud-tag-for-test',
  })
  try {
    await waitFor(s.out, /Access JWT check: ENFORCED/)
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 'in testing', capabilities: {}, clientInfo: { name: 't', version: '0' } } }
    const post = (headers) =>
      fetch(`${s.url}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify(init),
      })

    const bare = await post({})
    assert.equal(bare.status, 401)
    assert.match((await bare.json()).error, /missing Cf-Access-Jwt-Assertion/)

    const forged = await post({ 'Cf-Access-Jwt-Assertion': 'not.a.jwt' })
    assert.equal(forged.status, 403)

    // A well-formed but unsigned-by-Access token is no better.
    const fake = Buffer.from(JSON.stringify({ email: 'attacker@example.com', aud: 'aud-tag-for-test' })).toString('base64url')
    const shaped = await post({ 'Cf-Access-Jwt-Assertion': `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${fake}.sig` })
    assert.equal(shaped.status, 403)

    // The GET (SSE) and DELETE routes are gated by the same middleware.
    const get = await fetch(`${s.url}/mcp`, { headers: { Accept: 'text/event-stream' } })
    assert.equal(get.status, 401)
    const del = await fetch(`${s.url}/mcp`, { method: 'DELETE' })
    assert.equal(del.status, 401)
  } finally {
    s.child.kill('SIGKILL')
  }
})
