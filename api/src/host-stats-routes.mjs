/* ------------------------------------------------------------------ *
 * Host resource status — live RAM + swap for the hero readout, so the
 * box's memory pressure is visible at a glance (the early-warning the
 * 2026-06-25 agent-swarm freeze lacked: too many box-local agents drove
 * RAM to 94% on a no-swap box and it locked up before anyone saw it).
 *
 * Open like the other read endpoints (gated at the Access edge). Cached
 * briefly so a wall of dashboards / the TV poll doesn't re-read /proc on
 * every tick — the numbers move on a human timescale.
 *
 * Linux: parsed from /proc/meminfo (MemAvailable accounts for
 * reclaimable cache, unlike os.freemem, and it carries the swap figures).
 * Falls back to the os module (no swap) where /proc isn't present.
 * ------------------------------------------------------------------ */
import express from 'express'
import { totalmem, freemem } from 'node:os'
import { readFile } from 'node:fs/promises'

const CACHE_TTL_MS = Number(process.env.HOST_CACHE_TTL_MS || 2000)
let cache = null // { at: epochMs, payload }

const mb = (kb) => Math.round(kb / 1024)

async function readHost() {
  try {
    const raw = await readFile('/proc/meminfo', 'utf8')
    const kv = {}
    for (const line of raw.split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)/)
      if (m) kv[m[1]] = Number(m[2]) // values are in kB
    }
    const memTotal = kv.MemTotal
    const memAvail = kv.MemAvailable ?? kv.MemFree
    const memUsed = memTotal - memAvail
    const swapTotal = kv.SwapTotal || 0
    const swapUsed = swapTotal - (kv.SwapFree || 0)
    return {
      ok: true,
      mem: { pct: (memUsed / memTotal) * 100, usedMb: mb(memUsed), totalMb: mb(memTotal) },
      swap:
        swapTotal > 0
          ? { pct: (swapUsed / swapTotal) * 100, usedMb: mb(swapUsed), totalMb: mb(swapTotal) }
          : null,
    }
  } catch {
    // No /proc (non-Linux dev): coarse fallback from the os module. os.freemem
    // excludes reclaimable cache, so this overstates "used" — Linux always has
    // /proc, so it only bites in local dev. No swap figure available here.
    const total = totalmem()
    const used = total - freemem()
    return {
      ok: true,
      mem: { pct: (used / total) * 100, usedMb: Math.round(used / 1048576), totalMb: Math.round(total / 1048576) },
      swap: null,
    }
  }
}

export function hostRouter() {
  const r = express.Router()
  r.get('/api/host', async (_req, res) => {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return res.json(cache.payload)
    const payload = await readHost()
    cache = { at: Date.now(), payload }
    res.json(payload)
  })
  return r
}
