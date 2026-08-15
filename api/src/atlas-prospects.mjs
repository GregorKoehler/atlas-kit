/* ------------------------------------------------------------------ *
 * Task Prospects — agent-proposed Atlas tasks the operator signs off before
 * they become a real Tasks/<slug>.md note.
 *
 * The convention it enforces: an agent that notices follow-up work while doing
 * something else PROPOSES it here instead of filing a task itself. Unreviewed
 * agent-filed tasks inflate the Kanban with work nobody chose; a prospect costs
 * the operator one click to accept or dismiss.
 *
 * Storage: server-side ONLY, deliberately OUTSIDE the vault repo — mirrors
 * atlas-type-flags.mjs (dashboard metadata, not knowledge; a rejected
 * prospect must never touch the vault, not even transiently). Two records:
 *   prospects — the pending queue, one entry per proposal awaiting review.
 *   decisions — STICKY, keyed by the producer's own `sourceKey`, so a producer
 *     that re-scans the same source never re-proposes something the operator
 *     already approved OR rejected. Kept small on purpose: a decision + date,
 *     never the whole prospect.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const STATE_FILE =
  process.env.ATLAS_PROSPECTS_FILE || fileURLToPath(new URL('../.state/atlas-prospects.json', import.meta.url))

function today() {
  return new Date().toISOString().slice(0, 10)
}

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
    return {
      prospects: Array.isArray(data?.prospects) ? data.prospects : [],
      decisions: data && typeof data.decisions === 'object' && data.decisions ? data.decisions : {},
    }
  } catch {
    return { prospects: [], decisions: {} }
  }
}

// Atomic write (tmp + rename), like atlas-type-flags.mjs's setFlag.
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  const tmp = STATE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf-8')
  fs.renameSync(tmp, STATE_FILE)
}

// The sticky decision for a source key, or null if it's never been ruled on.
export function decisionFor(sourceKey) {
  if (!sourceKey) return null
  return loadState().decisions[sourceKey]?.decision || null
}

export function listProspects() {
  return loadState().prospects
}

// File a new prospect. Returns { ok:true, id }, or { ok:false, skipped } when
// the sticky decision store (or an already-pending prospect for the same
// source) means this exact source should NOT be re-queued — the guarantee that
// stops a repeating producer re-proposing a rejected item forever.
export function addProspect({ title, body, due, project, projectIdea, area, source, vault, sourceKey, producer }) {
  const state = loadState()
  if (sourceKey && state.decisions[sourceKey]) {
    return { ok: false, skipped: 'decided', decision: state.decisions[sourceKey].decision }
  }
  if (sourceKey && state.prospects.some((p) => p.sourceKey === sourceKey)) {
    return { ok: false, skipped: 'duplicate' }
  }
  const id = crypto.randomUUID()
  state.prospects.push({
    id,
    title,
    body: body || '',
    due: due || null,
    project: project || null,
    projectIdea: projectIdea || null,
    area: area || null,
    source: source || null,
    vault: vault || 'atlas',
    sourceKey: sourceKey || null,
    producer: producer || null,
    createdAt: today(),
  })
  saveState(state)
  return { ok: true, id }
}

// Remove a prospect from the pending queue (approve/reject) and, if it carries
// a sourceKey, stamp the STICKY decision so it's never re-proposed. Returns the
// removed prospect, or null if `id` isn't pending.
export function resolveProspect(id, decision) {
  const state = loadState()
  const idx = state.prospects.findIndex((p) => p.id === id)
  if (idx === -1) return null
  const [prospect] = state.prospects.splice(idx, 1)
  if (prospect.sourceKey) state.decisions[prospect.sourceKey] = { decision, at: today() }
  saveState(state)
  return prospect
}
