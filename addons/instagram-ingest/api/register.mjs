/* ------------------------------------------------------------------ *
 * `addons/instagram-ingest` — the addon's whole registration surface.
 *
 * Two routes and a status block. No search leg, no evidence leg, no scorecard
 * tiles, no cron: this addon does one thing when you ask it to, and adds nothing
 * to any read path. Disable it and the kit is byte-identical to one that never
 * had it (docs/ADDONS.md).
 *
 * 🔴 THE WRITE ROUTE GATES ITSELF. Addon routers are mounted WITHOUT core's
 * bearer middleware — core gates its own writes and cannot know which of an
 * addon's routes are writes — so `POST /api/ingest/instagram` carries the same
 * `DASHBOARD_BEARER_TOKEN` check core uses, constant-time, and refuses outright
 * when the server has no token configured. Without it, anything that could reach
 * the API could spend your Instagram session and your Claude subscription.
 * ------------------------------------------------------------------ */
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { ingestInstagram } from './ingest.mjs'
import { listRecords, recordsSummary } from './records.mjs'
import { ytdlpPath } from './ytdlp.mjs'
import { cookieConfig, model, vaultKey } from './config.mjs'

/* `express` lives in api/node_modules, and node resolves a bare specifier from
 * the IMPORTING file's directory — which for an addon walks up to a repo root
 * that has no node_modules. So it is required from core's own tree: an addon may
 * use what core already installed, and still must not add a dependency of its
 * own (docs/ADDONS.md). */
const express = createRequire(new URL('../../../api/src/', import.meta.url))('express')

function bearerAuth(req, res, next) {
  const token = process.env.DASHBOARD_BEARER_TOKEN || ''
  if (!token) return res.status(500).json({ error: 'server missing DASHBOARD_BEARER_TOKEN' })
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')
  if (!m) return res.status(401).json({ error: 'unauthorized' })
  const a = Buffer.from(m[1])
  const b = Buffer.from(token)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'unauthorized' })
  next()
}

export default function register() {
  const routes = express.Router()
  // Self-contained: core's global parser has usually run already (body-parser
  // skips a request it has parsed), but the router must also work mounted alone.
  routes.use('/api/ingest/instagram', express.json({ limit: '8kb' }))

  routes.post('/api/ingest/instagram', bearerAuth, async (req, res) => {
    const { status, ...body } = await ingestInstagram({ url: req.body?.url, requestedBy: 'api' })
    res.status(status).json(body)
  })

  /* The ingest log. A GET read, so it is open like core's reads (the edge gates
   * the origin) — it holds the URLs you ingested and how each went, which is the
   * same class of thing as the vault pages those ingests produced. */
  routes.get('/api/ingest/instagram/records', (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
    res.json({ records: listRecords(limit) })
  })

  return {
    description: 'Ingest one Instagram post or reel into the vault as a Wiki/Sources page — yt-dlp with YOUR OWN cookies for the caption + stills, claude -p for the analysis.',
    routes,

    /** Enough to tell "ready" from "enabled but nothing will work", without a log. */
    status: () => {
      const c = cookieConfig()
      return {
        ytdlp: ytdlpPath() || 'NOT FOUND — run addons/instagram-ingest/install.sh',
        cookies: c.file ? `file: ${c.file}` : c.browser ? `browser: ${c.browser}` : 'none configured — most posts will hit the login wall',
        model: model(),
        vault: vaultKey() || 'default',
        ingests: recordsSummary(),
      }
    },
  }
}
