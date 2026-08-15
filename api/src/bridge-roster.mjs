/* ------------------------------------------------------------------ *
 * Last-known remote roster per bridge — so "we could not ask" can never
 * render as "there is nothing there".
 *
 * When a bridge stops answering (a saturated box, its /sessions past
 * AGENT_BRIDGE_TIMEOUT_MS), the poll hysteresis in agent-routes rides out a blip
 * and then, correctly, flips the bridge to `reachable:false, sessions:[]`. What
 * is NOT correct is what every surface then draws: nothing. A silent bridge
 * reads as "something killed my agents" while all its sessions are alive inside
 * the dev-host container — a missing REPORT rendered as a missing THING.
 *
 * So each successful poll's roster is remembered here, and persisted: the API
 * restarts (deploys, the watchdog) far more often than a bridge outage lasts,
 * and an in-memory-only memory would go blank exactly when it is needed. The
 * rows are deliberately slim — the fields a STALE row is drawn from and
 * nothing else; transcripts, sub-agent fans and context meters have no meaning
 * once the bridge stopped answering.
 *
 * This module only REMEMBERS. Nothing here decides reachability, and the
 * remembered sessions are never merged into a live roster — that separation is
 * the whole point (see agent-routes' bridgeViews).
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STATE_DIR = process.env.AGENT_LOCAL_DIR || path.join(os.homedir(), '.atlas-kit')
const ROSTER_FILE = path.join(STATE_DIR, 'bridge-roster.json')
// A successful poll lands every few seconds; rewriting the file each time buys
// nothing. Persist on a CHANGED roster (that's the part worth not losing) and
// otherwise at most this often, which bounds how stale a restart's `lastSeen`
// can read (never staler, since `at` only moves forward).
const PERSIST_MS = Number(process.env.AGENT_BRIDGE_ROSTER_PERSIST_MS || 30_000)

// One row per remote session: id, kind, repo, status, what it's working on, and
// when it started. `lastSeen` is per-BRIDGE (the poll that saw them all), not
// per row.
function slimSession(s) {
  return {
    id: s.id,
    kind: s.kind || 'dev',
    repo: s.repo,
    status: s.status,
    task: s.task,
    title: s.title,
    startedAt: s.startedAt,
  }
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf-8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

const roster = load() // label -> { at: epoch ms, sessions: [slim] }
const lastWrite = new Map() // label -> the `at` value last written to disk
for (const [label, e] of Object.entries(roster)) if (e && e.at) lastWrite.set(label, e.at)

function persist() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(ROSTER_FILE, JSON.stringify(roster))
    for (const [label, e] of Object.entries(roster)) lastWrite.set(label, e.at)
  } catch (e) {
    console.error('[bridge-roster] persist failed:', e.message)
  }
}

/** Record what a bridge answered with. Call ONLY on a real fresh success — a
 * cached/stale serve must not refresh `lastSeen`, or "unreachable since" would
 * name a time nothing was actually observed. */
export function rememberRoster(label, sessions, now = Date.now()) {
  if (!label) return
  const slim = (Array.isArray(sessions) ? sessions : []).filter(Boolean).map(slimSession)
  const prev = roster[label]
  const changed = !prev || JSON.stringify(prev.sessions) !== JSON.stringify(slim)
  roster[label] = { at: now, sessions: slim }
  if (changed || now - (lastWrite.get(label) || 0) >= PERSIST_MS) persist()
}

/** The last roster this bridge answered with, or null if it has never answered
 * (in this process or any previous one). An EMPTY `sessions` with an `at` is a
 * real answer — the bridge was up and had no agents — and must stay
 * distinguishable from null, which is "we have never heard from it". */
export function lastKnownRoster(label) {
  const e = roster[label]
  if (!e || !e.at) return null
  return { at: e.at, sessions: (e.sessions || []).map((s) => ({ ...s })) }
}

/** Test-only: module state otherwise persists across test() blocks sharing a
 * process (same convention as agent-messages' __resetForTests). */
export function __resetRosterForTests() {
  for (const k of Object.keys(roster)) delete roster[k]
  lastWrite.clear()
}
