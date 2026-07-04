/* ------------------------------------------------------------------ *
 * Dev-agent live-app reverse proxy ("agent-app").
 *
 * A dev agent can run a live web app (Streamlit etc.) beside its transcript; the
 * dashboard embeds it in the full-screen split view. This module
 * is the box-side hop of the proxy chain:
 *
 *   browser → Caddy → Express (here) → [box-local: 127.0.0.1:<APP_PORT>]
 *                                    → [workstation: the bridge over Tailscale]
 *
 * Routing mirrors the exec routes: `/agent-app/<repo>/…` resolves by repo — a
 * box-local repo proxies straight to the on-box app port; anything else forwards
 * to the workstation bridge (with the bridge bearer injected, like callBridge),
 * which then reaches the container's published Streamlit port. The path is
 * PRESERVED end-to-end so Streamlit's `--server.baseUrlPath agent-app/<repo>`
 * matches and its `/_stcore/stream` WebSocket rides the same path.
 *
 * Auth: this path is Cloudflare-Access-gated only (like GET /api/agents) — an
 * iframe/WebSocket can't carry a bearer — so Caddy does NOT inject the dashboard
 * bearer here. The browser's Access cookie authorizes it (same origin).
 *
 * Dependency-free (node: builtins) — a hand-rolled proxy keeps the WebSocket
 * upgrade plumbing identical on both this hop and the bridge.
 * ------------------------------------------------------------------ */
import http from 'node:http'
import * as local from './agent-local.mjs'
import { bridgeForRepo } from './bridges.mjs'

const PREFIX = '/agent-app/'

// '/agent-app/<repo>/rest…' → '<repo>' (or '' if malformed / no repo segment).
function repoOf(urlPath) {
  if (typeof urlPath !== 'string' || !urlPath.startsWith(PREFIX)) return ''
  const rest = urlPath.slice(PREFIX.length)
  const slash = rest.indexOf('/')
  const q = rest.indexOf('?')
  const end = slash === -1 ? (q === -1 ? rest.length : q) : slash
  return rest.slice(0, end)
}

// Resolve a request path to its upstream { host, port, headers } — the box-local
// app port for an allowlisted repo, else the bridge that owns the repo (the
// workstation by default). null = no route.
function targetFor(urlPath) {
  const repo = repoOf(urlPath)
  if (!repo) return null
  if (local.isLocalRepo(repo)) {
    return { host: '127.0.0.1', port: local.appPort(repo), headers: {} }
  }
  const bridge = bridgeForRepo(repo)
  if (!bridge) return null
  const u = new URL(bridge.url)
  return {
    host: u.hostname,
    port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
    headers: { authorization: `Bearer ${bridge.token}` },
  }
}

// Forward an ordinary HTTP request (Express middleware, registered before the
// JSON body parser so the request stream is intact to pipe through).
export function appProxyHttp(req, res) {
  const t = targetFor(req.url)
  if (!t) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('no live app for this agent')
  }
  const up = http.request(
    { host: t.host, port: t.port, method: req.method, path: req.url, headers: { ...req.headers, ...t.headers } },
    (ur) => {
      res.writeHead(ur.statusCode || 502, ur.headers)
      ur.pipe(res)
    },
  )
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('app unreachable')
  })
  req.pipe(up)
}

// Forward a WebSocket upgrade to the same upstream. Attached to the http.Server
// (Express doesn't handle 'upgrade' itself), so it's the sole upgrade listener.
export function attachAppUpgrade(server) {
  server.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith(PREFIX)) return socket.destroy()
    const t = targetFor(req.url)
    if (!t) return socket.destroy()
    const up = http.request({
      host: t.host,
      port: t.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, ...t.headers },
    })
    up.on('upgrade', (ur, upSocket, upHead) => {
      const lines = ['HTTP/1.1 101 Switching Protocols']
      for (const [k, v] of Object.entries(ur.headers)) {
        if (Array.isArray(v)) for (const vv of v) lines.push(`${k}: ${vv}`)
        else lines.push(`${k}: ${v}`)
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n')
      if (upHead && upHead.length) socket.write(upHead)
      upSocket.pipe(socket)
      socket.pipe(upSocket)
      const close = () => {
        upSocket.destroy()
        socket.destroy()
      }
      upSocket.on('error', close)
      socket.on('error', close)
    })
    up.on('error', () => socket.destroy())
    if (head && head.length) up.write(head)
    up.end()
  })
}

// True for the request paths this proxy owns — server.mjs uses it to skip the
// JSON body parser (Streamlit bodies must stream, not be buffered/parsed).
export function isAppPath(p) {
  return typeof p === 'string' && p.startsWith(PREFIX)
}
