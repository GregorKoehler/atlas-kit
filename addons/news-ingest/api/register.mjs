/* ------------------------------------------------------------------ *
 * `addons/news-ingest` — the addon's whole registration surface.
 *
 * Two read routes, a cron entry and a status block. No search leg, no evidence
 * leg, no scorecard tiles: this addon writes into the vault on a schedule and
 * adds nothing to any read path core already had. Disable it and the kit is
 * byte-identical to one that never had it (docs/ADDONS.md).
 *
 * 🔴 THE SWEEP ROUTE GATES ITSELF. Addon routers are mounted WITHOUT core's
 * bearer middleware — core gates its own writes and cannot know which of an
 * addon's routes are writes — so `POST /api/news/sweep` carries the same
 * `DASHBOARD_BEARER_TOKEN` check core uses, constant-time, and refuses outright
 * when the server has no token configured. Without it, anything that could reach
 * the API could spend your Claude subscription in a loop.
 *
 * `GET /api/news` is open like core's reads (the edge gates the origin): it
 * serves the headlines this box already committed into the vault.
 * ------------------------------------------------------------------ */
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { loadFeeds } from './feeds.mjs'
import { readState, recentItems, recentRuns, stateSummary } from './state.mjs'
import { sweepNews } from './sweep.mjs'
import { limits, model, digestPage, vaultKey } from './config.mjs'

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

  /* What the News card reads: the items already ingested, newest first, plus
   * how the last sweep went — including its errors, because a card that shows
   * yesterday's headlines while every feed is 500ing is lying by omission. */
  routes.get('/api/news', (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20))
    const state = readState()
    const { feeds, errors } = loadFeeds()
    const runs = recentRuns(state, 1)
    res.json({
      items: recentItems(state, limit),
      feeds: feeds.map((f) => ({ tag: f.tag, title: f.title, url: f.url })),
      digest: digestPage(),
      lastRun: runs[0] || null,
      errors: [...errors, ...(runs[0]?.errors ?? [])],
    })
  })

  /* The manual sweep — the same run cron fires, on demand (what the skill and
   * `curl` use; the card only reads). Bearer-gated: it spends the subscription,
   * so it may not be reachable by anything that can merely reach the API. */
  routes.post('/api/news/sweep', bearerAuth, async (_req, res) => {
    const { status, ...body } = await sweepNews({ requestedBy: 'api' })
    res.status(status || 200).json(body)
  })

  return {
    description: 'Pull your RSS/Atom feeds into the vault on a schedule — each new item becomes a Wiki/Sources page summarized by claude -p, plus a rolling digest page.',
    routes,

    /* Hourly at :17 — offset from the top of the hour so it does not land with
     * every other cron on the box. Feeds update on their own clock and a page
     * that is an hour old is not a stale page; the per-run cap, not the cadence,
     * is what bounds the spend. */
    cron: [
      {
        schedule: '17 * * * *',
        command: 'bash addons/news-ingest/sweep.sh >> /tmp/atlas-kit-addons.log 2>&1',
        comment: 'RSS/Atom sweep → Wiki/Sources pages + the rolling digest',
      },
    ],

    /** Enough to tell "ready" from "enabled but nothing will happen", without a log. */
    status: () => {
      const { feeds, errors, file, exists } = loadFeeds()
      const { items, perFeed } = limits()
      return {
        feeds: exists ? feeds.length : `no feed list — copy feeds.example.json to ${file}`,
        feedErrors: errors,
        caps: `${items} item(s) per run, ${perFeed} per feed`,
        model: model(),
        digest: digestPage(),
        vault: vaultKey() || 'default',
        ...stateSummary(readState()),
      }
    },
  }
}
