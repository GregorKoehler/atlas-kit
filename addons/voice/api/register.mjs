/* ------------------------------------------------------------------ *
 * `addons/voice` — the addon's whole registration surface.
 *
 * Three routes and a status block. No search leg, no evidence leg, no cron, no
 * scorecard tiles: this addon adds a way to HEAR the fleet and to TALK to the
 * text fields, and touches no read path core already had. Disable it and the kit
 * is byte-identical to one that never had it (docs/ADDONS.md) — including
 * MicField, which falls back to rendering its child field and nothing else.
 *
 * 🔴 EVERY ROUTE HERE GATES ITSELF. Addon routers are mounted WITHOUT core's
 * bearer middleware — core gates its own writes and cannot know which of an
 * addon's routes spend something — and all three of these do: `/recap` spends a
 * `claude -p` call, `/speak` and `/transcribe` spend CPU on an on-box engine. So
 * each carries the same constant-time `DASHBOARD_BEARER_TOKEN` check core uses
 * and refuses outright when the server has no token configured.
 *
 * ⚠️ Which means the DASHBOARD reaches them only once you add a `/api/voice/*`
 * handler to your Caddyfile (the reverse proxy is where the token is injected;
 * the browser never holds it — see this addon's README). Until you do, the
 * addon still works: the zero-install path — the browser's own speechSynthesis
 * reading the event line, and its SpeechRecognition driving the mic — makes NO
 * server call at all. These routes are the enrichment, and the card says so
 * rather than failing silently.
 * ------------------------------------------------------------------ */
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { model, limits, ttsCmd, sttCmd } from './config.mjs'
import { EVENTS, recap, budgetState } from './summarize.mjs'
import { ttsStatus, sttStatus, speak, transcribe } from './engine.mjs'

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

  /* The tail arrives from the dashboard rather than being read here: the client
   * already holds every session's `lastOutput` from GET /api/agents, so posting
   * it costs one field instead of a second executor read — and it works for
   * bridge sessions, whose terminal this process cannot see at all. It is capped
   * on both sides (256 kB here, `tailChars` in cleanTail). */
  routes.post('/api/voice/recap', bearerAuth, express.json({ limit: '256kb' }), async (req, res) => {
    const { agentId = '', agent = '', event = 'manual', tail = '' } = req.body || {}
    if (!EVENTS.includes(event)) return res.status(400).json({ ok: false, error: `unknown event "${event}"` })
    if (typeof tail !== 'string' || !tail.trim()) return res.status(400).json({ ok: false, error: 'tail is required' })
    // 200 whichever way it lands: the REQUEST succeeded, and a guard skip is a
    // normal outcome the card renders (it speaks the event line instead).
    res.json(await recap({ agentId: String(agentId), agent: String(agent), event, tail }))
  })

  /* On-box speech, for the boxes that configured an engine. The browser default
   * never comes here. Audio goes back as bytes, not base64: it is played, not
   * inspected, and an <audio> src of a blob is what the card wants. */
  routes.post('/api/voice/speak', bearerAuth, express.json({ limit: '64kb' }), async (req, res) => {
    const text = String(req.body?.text || '')
    if (!text.trim()) return res.status(400).json({ ok: false, error: 'text is required' })
    const r = await speak(text.slice(0, limits().spokenChars))
    if (!r.ok) return res.status(503).json({ ok: false, error: r.error })
    res.type(r.mime).send(r.audio)
  })

  /* On-box dictation, for browsers with no Web Speech API. The clip is the raw
   * request body (MediaRecorder's blob, posted as-is) — no multipart, no temp
   * upload dir, and a size cap on the parser as well as in the engine. */
  routes.post(
    '/api/voice/transcribe',
    bearerAuth,
    express.raw({ type: () => true, limit: limits().audioBytes }),
    async (req, res) => {
      const r = await transcribe(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), { mime: req.headers['content-type'] || '' })
      if (!r.ok) return res.status(503).json({ ok: false, error: r.error })
      res.json(r)
    },
  )

  return {
    description:
      'Spoken recaps of fleet events and dictation into the dashboard\'s text fields — the browser speaks and listens by default (no download, no key); an on-box TTS/STT command can take over.',
    routes,

    /** Enough to tell "ready" from "enabled but nothing will speak", without a log. */
    status: () => {
      const tts = ttsStatus()
      const stt = sttStatus()
      const { minIntervalMs, dailyBudget } = limits()
      return {
        speech: ttsCmd() ? `on-box: ${ttsCmd()}` : 'browser speechSynthesis (zero-install default)',
        dictation: sttCmd() ? `on-box: ${sttCmd()}` : 'browser Web Speech API (zero-install default)',
        tts,
        stt,
        recap: {
          model: model(),
          guards: `1 per agent per ${Math.round(minIntervalMs / 1000)}s, ${dailyBudget}/day across the fleet, and never on an unchanged tail`,
          ...budgetState(),
        },
        bearer: process.env.DASHBOARD_BEARER_TOKEN
          ? 'configured — add a /api/voice/* handler to your Caddyfile so the dashboard can reach the routes'
          : 'MISSING — POST /api/voice/* refuses until DASHBOARD_BEARER_TOKEN is set',
      }
    },
  }
}
