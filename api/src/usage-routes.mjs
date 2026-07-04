/* ------------------------------------------------------------------ *
 * Claude subscription usage — surfaces the same 5-hour rolling and
 * weekly limits shown by Claude Code's /usage, so the dashboard can
 * display "how much of my Claude budget is left, and when it resets".
 *
 * There is no public API for this; the data comes from the undocumented
 * OAuth usage endpoint that Claude Code itself uses. We reuse the box's
 * subscription token (the same credentials `claude -p` runs on — see
 * .claude/rules/claude-p-subagent.md) read from ~/.claude/.credentials.json.
 * That token is refreshed by the regular `claude` runs on the box, so it
 * stays fresh without us managing the OAuth refresh dance here.
 *
 * Open like the other read endpoints (gated at the Access edge). Cached
 * in-process so a wall of dashboards / the TV poll doesn't hammer the
 * upstream — the numbers move slowly.
 * ------------------------------------------------------------------ */
import express from 'express'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CREDS_PATH =
  process.env.CLAUDE_CREDENTIALS_PATH || path.join(homedir(), '.claude', '.credentials.json')
const CACHE_TTL_MS = Number(process.env.USAGE_CACHE_TTL_MS || 60000)
const FETCH_TIMEOUT_MS = Number(process.env.USAGE_TIMEOUT_MS || 8000)

let cache = null // { at: epochMs, payload }

async function readToken() {
  const raw = await readFile(CREDS_PATH, 'utf8')
  const token = JSON.parse(raw)?.claudeAiOauth?.accessToken
  if (!token) throw new Error('no claudeAiOauth.accessToken in credentials')
  return token
}

// Map the upstream window shape → our compact, camelCase contract. Returns
// null for windows the account doesn't have (the endpoint sends null there).
function window(w) {
  if (!w || typeof w.utilization !== 'number') return null
  return { utilization: w.utilization, resetsAt: w.resets_at }
}

async function fetchUsage() {
  const token = await readToken()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`upstream ${res.status}`)
    const j = await res.json()
    return { ok: true, fiveHour: window(j.five_hour), sevenDay: window(j.seven_day) }
  } finally {
    clearTimeout(timer)
  }
}

export function usageRouter() {
  const r = express.Router()

  r.get('/api/usage', async (_req, res) => {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return res.json(cache.payload)
    try {
      const payload = await fetchUsage()
      cache = { at: Date.now(), payload }
      res.json(payload)
    } catch (e) {
      // Degrade quietly: the card hides when usage can't be read (expired
      // token, offline, endpoint changed) rather than showing a broken meter.
      res.status(502).json({ ok: false, error: e?.message || String(e) })
    }
  })

  return r
}
