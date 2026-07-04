/* ------------------------------------------------------------------ *
 * Bridge registry — resolves a repo (and, via agent-routes, a session id)
 * to the remote agent-bridge that owns it.
 *
 * The legacy AGENT_BRIDGE_URL/AGENT_BRIDGE_TOKEN is the DEFAULT bridge
 * (label AGENT_WORKSTATION_LABEL, default "workstation"); it is the
 * CATCH-ALL — it claims any repo no explicit bridge lists, so an existing
 * single-bridge setup is byte-identical with no bridges.json present. Extra
 * bridges come from bridges.json beside this module (or AGENT_BRIDGES, a JSON
 * array env), each { label, url, token, repos:[keys] }. Read FRESH per call
 * (like agent-local-repos.json) so edits need no Express restart.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const BRIDGES_FILE = process.env.AGENT_BRIDGES_FILE || path.join(HERE, 'bridges.json')
const DEFAULT_LABEL = process.env.AGENT_WORKSTATION_LABEL || 'workstation'

function parseJson(s, fallback) {
  try {
    return JSON.parse(s)
  } catch {
    return fallback
  }
}

// Normalize one raw entry → { label, url, token, repos:string[] } or null.
function norm(e) {
  if (!e || typeof e !== 'object') return null
  const url = String(e.url || '').replace(/\/$/, '')
  const token = String(e.token || '')
  if (!url || !token) return null
  const repos = Array.isArray(e.repos) ? e.repos.map(String) : []
  return { label: String(e.label || url), url, token, repos }
}

// Explicit extra bridges from AGENT_BRIDGES (a JSON array) or bridges.json (a
// bare array, or { bridges:[…] } so the .example can carry a _comment).
function extraBridges() {
  let raw
  if (process.env.AGENT_BRIDGES) {
    raw = parseJson(process.env.AGENT_BRIDGES, null)
  } else {
    try {
      raw = JSON.parse(fs.readFileSync(BRIDGES_FILE, 'utf-8'))
    } catch {
      raw = null
    }
  }
  if (raw && !Array.isArray(raw) && Array.isArray(raw.bridges)) raw = raw.bridges
  if (!Array.isArray(raw)) return []
  return raw.map(norm).filter(Boolean)
}

// Advertised dev-repo keys for the DEFAULT (catch-all) bridge. The catch-all
// keeps `repos: []` — that's how catch-all ROUTING is detected (it claims any
// repo no explicit bridge lists), so its concrete dev repos can't live there
// without breaking routing. AGENT_BRIDGE_REPOS names them for DISCOVERY only:
// an orchestrator's `list_agents` surfaces them as spawnable, routing unchanged.
// Comma/space-separated (e.g. "my-app,my-service") or a JSON array.
function defaultAdvertise() {
  const raw = process.env.AGENT_BRIDGE_REPOS
  if (!raw) return []
  const arr = parseJson(raw, null)
  if (Array.isArray(arr)) return arr.map(String)
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// The full bridge list, default (catch-all) FIRST. Re-read per call.
export function bridges() {
  const out = []
  const durl = (process.env.AGENT_BRIDGE_URL || '').replace(/\/$/, '')
  const dtok = process.env.AGENT_BRIDGE_TOKEN || ''
  if (durl && dtok) out.push({ label: DEFAULT_LABEL, url: durl, token: dtok, repos: [], advertise: defaultAdvertise() })
  out.push(...extraBridges())
  return out
}

// The dev-repo keys a bridge ADVERTISES as spawnable — what `list_agents` shows
// so an orchestrator can discover targets. An explicit bridge advertises its own
// `repos`; the catch-all default bridge (`repos: []`) advertises `advertise`
// (from AGENT_BRIDGE_REPOS). Advertisement is DISCOVERY only — never routing.
export function advertisedRepos(b) {
  if (!b) return []
  return b.repos && b.repos.length ? b.repos : b.advertise || []
}

// The default (catch-all) bridge — the legacy workstation — or null.
export function defaultBridge() {
  return bridges().find((b) => b.repos.length === 0) || null
}

export function defaultLabel() {
  return DEFAULT_LABEL
}

// repo KEY → its bridge: the first explicit bridge that lists it, else the
// default (catch-all) bridge. null when nothing claims it and no default.
export function bridgeForRepo(repo) {
  const all = bridges()
  return all.find((b) => b.repos.includes(repo)) || all.find((b) => b.repos.length === 0) || null
}

// A bridge by its label (for id → bridge resolution in agent-routes).
export function bridgeByLabel(label) {
  return bridges().find((b) => b.label === label) || null
}
