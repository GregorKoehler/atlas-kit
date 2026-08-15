/* ------------------------------------------------------------------ *
 * Shared Claude-budget poll (GET /api/usage).
 *
 * The hero's budget meters AND every open full-screen agent viewer want the
 * same numbers, and every request crosses the tunnel — so one module-level
 * loop feeds all of them (same shape as useAgents.ts): one request per cycle
 * no matter how many readouts are mounted, at the hero's original 60s cadence,
 * paused while the tab is hidden and stopped entirely when nothing is
 * subscribed.
 * ------------------------------------------------------------------ */
import { useEffect, useState } from 'preact/hooks'
import { fetchUsage, type ClaudeUsage } from './api'

const INTERVAL_MS = 60000

let usage: ClaudeUsage | null = null
let misses = 0
const subscribers = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | null = null
let visBound = false

function stop() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

function schedule() {
  stop()
  timer = setTimeout(tick, INTERVAL_MS)
}

async function tick() {
  if (!subscribers.size) return stop() // nothing mounted — go dormant
  if (typeof document !== 'undefined' && document.hidden) return schedule()
  const u = await fetchUsage()
  if (!subscribers.size) return stop() // unmounted during the await
  if (u) {
    usage = u
    misses = 0
  } else {
    misses++
  }
  // Emit on failures too — that's what lets a held-over readout say it's stale.
  for (const cb of subscribers) cb()
  schedule()
}

function onVisible() {
  if (!document.hidden && subscribers.size) {
    stop()
    tick()
  }
}

const two = (n: number) => String(n).padStart(2, '0')

/** "14:29" if the reset is within a day, else "Thu 18:00" — enough to know when
 *  the budget comes back without a full date. */
export function fmtReset(iso: string): string {
  const d = new Date(iso)
  const hhmm = `${two(d.getHours())}:${two(d.getMinutes())}`
  const soon = d.getTime() - Date.now() < 24 * 60 * 60 * 1000
  return soon ? hhmm : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${hhmm}`
}

/**
 * Subscribe to the shared Claude budget. The first mounted readout starts the
 * loop; the last to unmount stops it. New subscribers immediately see the
 * cached value (no refetch storm when the hero and a viewer mount together).
 *
 * `usage` stays null until the endpoint first answers — callers render nothing
 * rather than a misleading 0%. `stale` means the last two polls failed, so the
 * numbers still on screen are older than they look (a held value beats a
 * flicker to nothing).
 */
export function useUsage(): { usage: ClaudeUsage | null; stale: boolean } {
  const [, force] = useState(0)
  useEffect(() => {
    const cb = () => force((n) => n + 1)
    subscribers.add(cb)
    if (typeof document !== 'undefined' && !visBound) {
      document.addEventListener('visibilitychange', onVisible)
      visBound = true
    }
    if (subscribers.size === 1) tick() // first readout mounted → (re)start the loop
    return () => {
      subscribers.delete(cb)
      if (subscribers.size === 0) stop()
    }
  }, [])
  return { usage, stale: misses >= 2 }
}
