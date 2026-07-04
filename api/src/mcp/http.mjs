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
 * Run: node --env-file=../../.env api/src/mcp/http.mjs
 * Config: MCP_PORT (default 3002), MCP_BIND (default 127.0.0.1).
 * ------------------------------------------------------------------ */
import express from 'express'
import { randomUUID } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { buildServer } from './tools.mjs'

const PORT = Number(process.env.MCP_PORT || 3002)
const BIND = process.env.MCP_BIND || '127.0.0.1'

// Cloudflare Access (Managed OAuth) fronts mcp.<domain> and runs the OAuth flow;
// every request it proxies carries a signed Cf-Access-Jwt-Assertion. Verify it
// here (signature vs the team JWKS, issuer, audience) as defense-in-depth — the
// origin then can't be reached by anything that didn't pass through Access.
// No-op when unconfigured (local dev / before the Access app exists).
const CF_TEAM = process.env.CF_ACCESS_TEAM_DOMAIN || '' // e.g. yourteam.cloudflareaccess.com
const CF_AUD = process.env.CF_ACCESS_AUD || '' // the Access application's AUD tag
let _jwks
const jwks = () => (_jwks ??= createRemoteJWKSet(new URL(`https://${CF_TEAM}/cdn-cgi/access/certs`)))

async function cfAccess(req, res, next) {
  if (!CF_TEAM || !CF_AUD) return next() // unconfigured → open (localhost-only anyway)
  const token = req.headers['cf-access-jwt-assertion']
  if (!token) return res.status(401).json({ error: 'missing Cf-Access-Jwt-Assertion' })
  try {
    const { payload } = await jwtVerify(token, jwks(), { issuer: `https://${CF_TEAM}`, audience: CF_AUD })
    req.accessEmail = payload.email
    next()
  } catch (e) {
    res.status(403).json({ error: 'invalid Access JWT', detail: e?.message || String(e) })
  }
}

const app = express()
app.use(express.json({ limit: '256kb' }))

app.get('/health', (_req, res) => res.json({ ok: true, service: 'atlas-kit-mcp' }))

// sessionId → transport
const transports = {}

app.post('/mcp', cfAccess, async (req, res) => {
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
    await buildServer().connect(transport)
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

app.listen(PORT, BIND, () =>
  console.error(
    `[atlas-kit-mcp] HTTP on http://${BIND}:${PORT}/mcp — Access JWT check: ${CF_TEAM && CF_AUD ? 'ENFORCED' : 'off (unconfigured)'}`,
  ),
)
