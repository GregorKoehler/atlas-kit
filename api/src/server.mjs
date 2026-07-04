/* ------------------------------------------------------------------ *
 * Atlas Kit API — the single Express app.
 *
 * Mounts:
 *   - read-routes  (open GET reads: vault notes/wiki/search/tasks/projects
 *                   + the typed Atlas query)
 *   - agent-routes (dev + knowledge agent lifecycle; writes bearer-gated)
 *   - atlas-routes (Kanban task writes via the serial commit queue; bearer)
 *   - agent-app-proxy (dev-agent live-app preview: HTTP + WebSocket)
 *
 * Auth: every write/exec route is gated on a single shared bearer,
 * DASHBOARD_BEARER_TOKEN. In production Caddy injects it server-side so the
 * browser never holds it, and Cloudflare Access fronts the whole origin. The
 * server binds 127.0.0.1 only. GET reads are open (Access gates them at the edge).
 * ------------------------------------------------------------------ */
import express from 'express'
import crypto from 'node:crypto'
import { readRouter } from './read-routes.mjs'
import { agentRouter } from './agent-routes.mjs'
import { atlasRouter } from './atlas-routes.mjs'
import { usageRouter } from './usage-routes.mjs'
import { hostRouter } from './host-stats-routes.mjs'
import { appProxyHttp, attachAppUpgrade, isAppPath } from './agent-app-proxy.mjs'

const PORT = Number(process.env.API_PORT || 3001)
const HOST = process.env.API_HOST || '127.0.0.1'
const TOKEN = process.env.DASHBOARD_BEARER_TOKEN || ''

const app = express()
app.disable('x-powered-by')

// These agent routes carry base64 image attachments and parse their own (roomy)
// JSON body inside agent-routes; keep the small global parser off them.
const LARGE_BODY_ROUTES = new Set([
  '/api/agents/spawn',
  '/api/agents/prompt',
  '/api/agents/interrupt',
  '/api/agents/queue',
])
const jsonSmall = express.json({ limit: '64kb' })

// Order matters: the live-app proxy runs first (streams HTTP + upgrades to WS,
// so it must bypass the JSON body parser), then the conditional parser.
app.use((req, res, next) => (isAppPath(req.path) ? appProxyHttp(req, res) : next()))
app.use((req, res, next) => (LARGE_BODY_ROUTES.has(req.path) ? next() : jsonSmall(req, res, next)))

// Constant-time bearer check; passed into the write routers.
function timingSafeEqual(a, b) {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}
function bearerAuth(req, res, next) {
  if (!TOKEN) return res.status(500).json({ error: 'server missing DASHBOARD_BEARER_TOKEN' })
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')
  if (!m || !timingSafeEqual(m[1], TOKEN)) return res.status(401).json({ error: 'unauthorized' })
  next()
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'atlas-kit-api' }))

app.use(readRouter())
app.use(agentRouter(bearerAuth))
app.use(atlasRouter(bearerAuth))
app.use(usageRouter()) // GET /api/usage — Claude 5h/weekly budget (Hero meters)
app.use(hostRouter()) // GET /api/host — box RAM/swap (Hero meters)

const server = app.listen(PORT, HOST, () => {
  console.error(`[atlas-kit-api] listening on http://${HOST}:${PORT}`)
})
// Reverse-proxy WebSocket upgrades for the dev-agent live-app preview.
attachAppUpgrade(server)
