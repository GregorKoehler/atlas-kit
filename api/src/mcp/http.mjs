#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * Atlas Kit MCP server — streamable-HTTP entry (the remote Claude.ai
 * connector path). Same tools as the stdio server (tools.mjs).
 *
 * Stateful sessions: an `initialize` POST (no session header) spins up a
 * transport + a fresh McpServer and returns an `mcp-session-id`; later
 * POST/GET/DELETE on /mcp carry that header. GET opens the SSE stream.
 *
 * Binds 127.0.0.1 by default — it is NOT an auth boundary on its own.
 * The remote exposure (Cloudflare Tunnel → mcp.<domain>) and the OAuth /
 * Access layer go IN FRONT of this; see docs/SETUP.md.
 *
 * FAILS CLOSED (http-policy.mjs): being REACHABLE without Access configured
 * EXITS NON-ZERO instead of serving — reachable meaning a non-loopback
 * MCP_BIND *or* a cloudflared ingress rule for this port (cloudflared dials
 * loopback, so the bind alone proves nothing). Present-but-empty CF_ACCESS_*
 * counts as unset, and an inactive gate is always logged — it can never be
 * silently off. The tool surface here is KNOWLEDGE-ONLY by default (the 7 read
 * tools) and NEVER carries the agent-control tools, whatever the env says.
 *
 * Run: node --env-file=../../.env api/src/mcp/http.mjs
 * Config: MCP_PORT (default 3002), MCP_BIND (default 127.0.0.1),
 *         CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD, ATLAS_MCP_HTTP_SURFACE.
 * ------------------------------------------------------------------ */
import express from 'express'
import { randomUUID } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { buildServer } from './tools.mjs'
import { accessPolicy, accessPrincipal, cleanEnv, readTunnelIngress, toolSurface } from './http-policy.mjs'

const PORT = Number(process.env.MCP_PORT || 3002)
const BIND = cleanEnv(process.env.MCP_BIND) || '127.0.0.1'

// Cloudflare Access (Managed OAuth, or a Service Auth policy for machine callers)
// fronts mcp.<domain>; every request it proxies carries a signed
// Cf-Access-Jwt-Assertion. Verify it here (signature vs the team JWKS, issuer,
// audience) — and refuse to run at all if we are reachable without that gate.
const CF_TEAM = cleanEnv(process.env.CF_ACCESS_TEAM_DOMAIN) // e.g. yourteam.cloudflareaccess.com
const CF_AUD = cleanEnv(process.env.CF_ACCESS_AUD) // the Access application's AUD tag
// Loopback is not the same as unreachable: cloudflared dials localhost, so an ingress
// rule for this port publishes it while the bind still looks safe — and that is exactly
// what infra/cloudflared-config.example.yml sets up. Read the tunnel's own config so
// that case fails closed too.
const TUNNEL = readTunnelIngress(PORT)
const POLICY = accessPolicy({ bind: BIND, team: CF_TEAM, aud: CF_AUD, tunnel: TUNNEL })
if (!POLICY.ok) {
  console.error(POLICY.message)
  process.exit(1)
}
const SURFACE = toolSurface(process.env)

let _jwks
const jwks = () => (_jwks ??= createRemoteJWKSet(new URL(`https://${CF_TEAM}/cdn-cgi/access/certs`)))

async function cfAccess(req, res, next) {
  // Unenforced is now only ever the loopback-dev case — accessPolicy() exits
  // rather than let this branch be reached on a reachable bind.
  if (!POLICY.enforced) return next()
  const token = req.headers['cf-access-jwt-assertion']
  if (!token) return res.status(401).json({ error: 'missing Cf-Access-Jwt-Assertion' })
  try {
    const { payload } = await jwtVerify(token, jwks(), { issuer: `https://${CF_TEAM}`, audience: CF_AUD })
    // A service-token JWT has no `email` (and `sub: ""`) — it identifies itself by
    // `common_name`. Accept that WITHOUT loosening verification above, but a token
    // that names nobody at all is rejected rather than served anonymously.
    const principal = accessPrincipal(payload)
    if (!principal) return res.status(403).json({ error: 'Access JWT names no principal (no email, no common_name)' })
    req.accessPrincipal = principal.id
    req.accessEmail = principal.email
    next()
  } catch (e) {
    res.status(403).json({ error: 'invalid Access JWT', detail: e?.message || String(e) })
  }
}

const app = express()
// Body parsing is per-route and BEHIND cfAccess: an unauthenticated caller should
// not get us to parse its JSON at all.
const body = express.json({ limit: '256kb' })

app.get('/health', (_req, res) => res.json({ ok: true, service: 'atlas-kit-mcp' }))

// sessionId → transport
const transports = {}

app.post('/mcp', cfAccess, body, async (req, res) => {
  const sid = req.headers['mcp-session-id']
  let transport = sid ? transports[sid] : undefined

  if (!transport && isInitializeRequest(req.body)) {
    // New session. Also the recovery path: a client whose session we lost (the
    // 404 branch below) re-initializes here with no session id and gets a fresh one.
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports[id] = transport
      },
    })
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId]
    }
    // KNOWLEDGE-ONLY unless explicitly widened, and NEVER agent-control: this is
    // the surface a remote connector (or a remote dev-agent container) reaches, so
    // it gets reads over the vault and nothing that spawns, steers or kills an agent.
    await buildServer({ knowledgeOnly: SURFACE === 'knowledge', agentControl: false }).connect(transport)
  } else if (!transport && sid) {
    // Stale session id: the session is gone (server restart wiped this in-memory
    // map, or it was reaped) but the client still holds the old id. Spec says
    // respond 404 so the client starts a fresh session by re-initializing
    // (MCP 2025-03-26, Session Management §3–4). Returning 400 here is what wedged
    // long-lived clients on -32000 — 400 is not the documented re-init trigger.
    return res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found: re-initialize' },
      id: req.body?.id ?? null,
    })
  } else if (!transport) {
    // No session id at all and not an initialize request — protocol error (spec §2).
    return res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: no valid session (initialize first)' },
      id: null,
    })
  }

  await transport.handleRequest(req, res, req.body)
})

// GET (SSE stream) + DELETE (session teardown) reuse the session's transport.
const bySession = async (req, res) => {
  const sid = req.headers['mcp-session-id']
  const transport = sid ? transports[sid] : undefined
  // 404 for a stale/unknown session id so the client re-initializes (spec §3–4);
  // 400 only when no id was sent at all.
  if (!transport) return res.status(sid ? 404 : 400).send(sid ? 'Session not found' : 'Missing mcp-session-id')
  await transport.handleRequest(req, res)
}
app.get('/mcp', cfAccess, bySession)
app.delete('/mcp', cfAccess, bySession)

app.listen(PORT, BIND, () => {
  console.error(
    `[atlas-kit-mcp] HTTP on http://${BIND}:${PORT}/mcp — Access JWT check: ${
      POLICY.enforced ? 'ENFORCED' : 'INACTIVE (unconfigured)'
    }, tools: ${SURFACE}-only`,
  )
  // Loud, every start: an unauthenticated /mcp or a reachable origin must never be
  // something you have to read the env to notice.
  for (const w of POLICY.warnings) console.error(`[atlas-kit-mcp] WARNING: ${w}`)
  if (SURFACE === 'broad') {
    console.error(
      '[atlas-kit-mcp] WARNING: ATLAS_MCP_HTTP_SURFACE=broad — this endpoint serves the FULL non-control ' +
        'tool set, not just the 7 knowledge reads. Only ever behind Access.',
    )
  }
})
