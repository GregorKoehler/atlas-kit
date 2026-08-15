/* ------------------------------------------------------------------ *
 * Shared box-memory poll (GET /api/host).
 *
 * Same reasoning as useUsage.ts: the hero's RAM/SWAP meters AND every open
 * full-screen agent viewer want the same numbers, and every request crosses
 * the tunnel — so one module-level loop feeds all of them. One request per
 * cycle no matter how many readouts are mounted, at the hero's original 10s
 * cadence, paused while the tab is hidden and stopped entirely when nothing is
 * subscribed.
 * ------------------------------------------------------------------ */
import { useEffect, useState } from 'preact/hooks'
import { fetchHost, type HostStats } from './api'

const INTERVAL_MS = 10000

let host: HostStats | null = null
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
  const h = await fetchHost()
  if (!subscribers.size) return stop() // unmounted during the await
  if (h) {
    host = h
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

/** "41.2" — megabytes as gigabytes, one decimal. Shared so the hero's meters
 *  and the viewer's RAM chip can't drift apart in precision. */
export const gb = (mb: number) => (mb / 1024).toFixed(1)

/**
 * Subscribe to the shared host stats. The first mounted readout starts the
 * loop; the last to unmount stops it. New subscribers immediately see the
 * cached value (no refetch storm when the hero and a viewer mount together).
 *
 * `host` stays null until the endpoint first answers — callers render nothing
 * rather than a misleading 0%. `stale` means the last two polls failed, so the
 * numbers still on screen are older than they look (a held value beats a
 * flicker to nothing).
 */
export function useHost(): { host: HostStats | null; stale: boolean } {
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
  return { host, stale: misses >= 2 }
}
