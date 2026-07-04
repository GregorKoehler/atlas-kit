/* ------------------------------------------------------------------ *
 * Operator duplicate-flags for the Atlas Type Registry card.
 *
 * The Type Registry (GET /api/atlas/types) is a LIVE view of the node/edge/
 * property names actually used in a vault, cross-referenced with its Legend.
 * The operator can flag an entry they suspect is a duplicate/synonym of another
 * (so the knowledge agent can reconcile it later). Those flags are dashboard
 * METADATA, not knowledge — so they live in a small server-side JSON file
 * (container-local, gitignored, like the capture queue's persist.mjs), NOT
 * written into the Atlas repo (the dashboard "never writes uninvited" there).
 *
 * A flag key is `${vault}:${category}:${name}` (vault-scoped so recipes/work
 * flags can't collide with atlas ones). Present-and-true = flagged; toggling off
 * deletes the key so the file only ever holds active flags.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const STATE_FILE =
  process.env.ATLAS_TYPE_FLAGS_FILE ||
  fileURLToPath(new URL('../.state/atlas-type-flags.json', import.meta.url))

export function flagKey(vault, category, name) {
  return `${vault}:${category}:${name}`
}

export function loadFlags() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
    if (data && typeof data.flags === 'object' && data.flags) return data.flags
  } catch {
    /* no flags yet, or unreadable → none */
  }
  return {}
}

// Atomic write (tmp + rename) so a crash mid-write can't corrupt the file.
export function setFlag(key, flagged) {
  const flags = loadFlags()
  if (flagged) flags[key] = true
  else delete flags[key]
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    const tmp = STATE_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ flags }), 'utf-8')
    fs.renameSync(tmp, STATE_FILE)
  } catch (e) {
    console.error('[atlas] type-flag save failed:', e?.message || e)
  }
  return flags
}
