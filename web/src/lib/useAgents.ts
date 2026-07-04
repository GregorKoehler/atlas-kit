/* ------------------------------------------------------------------ *
 * Shared dev-agent poll.
 *
 * The global Dev Agents card AND every per-project card want the same
 * GET /api/agents data, and every request crosses the Cloudflare tunnel.
 * So a single module-level poll loop feeds all of them: one request per
 * cycle no matter how many cards subscribe. Cards filter the shared
 * `sessions` client-side (by repo) — no per-card fetch, no bridge change.
 *
 * Cadence matches the old per-card behaviour: fast (5s) only while an agent
 * is running, slow (30s) when idle, paused while the tab is hidden, and
 * stopped entirely when no card is mounted (e.g. on another dashboard tab).
 * ------------------------------------------------------------------ */
import { useEffect, useState } from 'preact/hooks'
import { fetchAgents, type AgentsView } from './api'

let view: AgentsView | null = null
const subscribers = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | null = null
let visBound = false

function emit() {
  for (const cb of subscribers) cb()
}

function stop() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

function schedule(active: boolean) {
  stop()
  timer = setTimeout(tick, active ? 5000 : 30000)
}

async function tick() {
  if (!subscribers.size) return stop() // nothing mounted — go dormant
  if (typeof document !== 'undefined' && document.hidden) return schedule(false)
  const v = await fetchAgents()
  if (!subscribers.size) return stop() // unmounted during the await
  if (v) {
    view = v
    emit()
  }
  // Fast-poll while any agent is alive — 'running' (working) OR 'idle' (waiting
  // on you). Both want a snappy light when the state flips; only done/error rest.
  // Also stay fast while an Atlas activity (deep research / a pass) is running, so
  // the constellation tracks its fan-out live even with no interactive session up.
  schedule(
    !!v &&
      (v.sessions.some((s) => s.status === 'running' || s.status === 'idle') ||
        (v.activities?.some((a) => a.status === 'running') ?? false)),
  )
}

/** Force an immediate refresh — call right after a spawn/prompt/kill. */
export function kickAgents() {
  if (subscribers.size) {
    stop()
    tick()
  }
}

function onVisible() {
  if (!document.hidden) kickAgents()
}

/**
 * Subscribe to the shared agents view. The first mounted card starts the poll
 * loop; the last to unmount stops it. New subscribers immediately see the
 * cached `view` (no refetch storm when several cards mount together).
 */
export function useAgents(): { view: AgentsView | null; kick: () => void } {
  const [, force] = useState(0)
  useEffect(() => {
    const cb = () => force((n) => n + 1)
    subscribers.add(cb)
    if (typeof document !== 'undefined' && !visBound) {
      document.addEventListener('visibilitychange', onVisible)
      visBound = true
    }
    if (subscribers.size === 1) tick() // first card mounted → (re)start the loop
    return () => {
      subscribers.delete(cb)
      if (subscribers.size === 0) stop()
    }
  }, [])
  return { view, kick: kickAgents }
}
