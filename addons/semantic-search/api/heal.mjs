/* ------------------------------------------------------------------ *
 * The self-heal, READ side — so a missing encoder SAYS SO instead of just
 * being missing.
 *
 * The encoder lives out of tree (~1.4 GB, `ATLAS_EMBED_DIR`) precisely so it
 * stays off every `npm ci`, which also means no deploy ever puts it back. Its
 * loss is otherwise SILENT: search keeps answering with the full-text leg alone
 * and the dense leg just reports `available: false`. So `install.sh --heal`
 * reinstalls it — guarded by a persisted exponential backoff and a single-flight
 * lock — from the same cron line that runs the index sweep, and it records what
 * it did in a small state file.
 *
 * 🔴 THIS MODULE NEVER INSTALLS ANYTHING. It only READS that state file, so the
 * leg's `reason` can distinguish four situations a bare "encoder not installed"
 * flattens into one: never installed, currently reinstalling, failed and backing
 * off, and deliberately switched off. A 1.4 GB download must be triggered by a
 * scheduled job the operator installed, never by an inbound HTTP request.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Written by `install.sh` — keep the path in step with its `STATE` variable. */
export const STATE_FILE =
  process.env.ATLAS_EMBED_STATE_FILE || path.join(process.env.AGENT_LOCAL_DIR || path.join(os.homedir(), '.atlas-kit'), 'semantic-search-install.state')

/** `key=value` lines → object. An absent or unreadable file is `{}`, which is
 *  the same thing it means on disk: nothing has been recorded. */
export function installState(file = STATE_FILE) {
  const out = {}
  try {
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      const i = line.indexOf('=')
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
  } catch {
    /* nothing recorded */
  }
  return out
}

/* A reinstall that started but never wrote an outcome — the box rebooted, the
 * process was killed — must not read as "installing" forever, or the reason
 * line becomes a lie that never expires. Past this, `phase=running` is reported
 * as stalled and the next scheduled heal is what fixes it. */
const RUNNING_MAX_MS = Number(process.env.ATLAS_EMBED_RUNNING_MAX_MS || 90 * 60 * 1000)

/**
 * One clause explaining what the self-heal is doing about a missing encoder,
 * or '' when there is nothing to add. Appended to the leg's `reason`.
 */
export function healNote(state = installState(), now = Date.now()) {
  if (process.env.ATLAS_EMBED_AUTOINSTALL === '0') return 'auto-reinstall is off (ATLAS_EMBED_AUTOINSTALL=0)'
  const started = Number(state.started) * 1000
  if (state.phase === 'running') {
    if (Number.isFinite(started) && now - started < RUNNING_MAX_MS) return 'a reinstall is running now — the leg comes back on its own once it finishes'
    return 'a reinstall started and never reported back (interrupted?) — the next scheduled heal retries'
  }
  if (state.phase === 'failed') {
    const n = Number(state.failures) || 1
    const why = state.reason ? `: ${state.reason}` : ''
    return `${n} failed reinstall attempt${n === 1 ? '' : 's'}${why} — backing off, the next scheduled heal retries`
  }
  return 'the scheduled sweep reinstalls it automatically (addons/semantic-search/install.sh wires that cron entry)'
}
