/* ------------------------------------------------------------------ *
 * Agent spawn capacity — ONE rule, read from /proc, applied in three places.
 *
 * The box-local executor has had a RAM-aware brake for a while (a MAX_LIVE count
 * ceiling plus a free-RAM gate). It protected the DASHBOARD box and nothing else:
 * `atCapacity()` lives in agent-local.mjs and is called from that file only, so
 * the remote path (`callBridge('POST','/spawn', …)`) admitted an unbounded number
 * of agents onto someone ELSE'S box — which is backwards from where the risk is.
 * A small bridge box (4 vCPU / 8 GB, also running CI and preview stacks) will hit
 * a three-figure load average, fall off its network and spend the day OOM-killing
 * whatever else it runs, with seven agent sessions live on it. Nothing refuses an
 * eighth.
 *
 * So the RULE lives here, once, and every gate calls it:
 *   1. agent-local.mjs   — the box-local spawn/revive paths (unchanged behaviour)
 *   2. agent-routes.mjs  — the remote spawn path, on what the bridge reports
 *   3. agent-bridge/server.mjs — the bridge refusing on its own box
 * A second implementation would drift, and only one of them would be maintained.
 *
 * ⚠️ WHICH NUMBER. `MemAvailable`, never `MemFree`/`os.freemem()`: the kernel's
 * own estimate of what a new workload can have without swapping, so page cache
 * (which a busy CI box is full of) doesn't read as "used". And, for a box already
 * IN swap, MemAvailable alone still reads healthier than the machine is — a box
 * can report ~4 GB available with ~3.5 GB of anonymous pages already pushed to
 * swap. Those pages are not gone: an IDLE agent's are cold and swappable, but the
 * moment it takes a turn they must fault back into RAM, and they will be
 * competing with whatever we just admitted. So `chargeSwap` charges swap-in-use
 * against availability — the pessimistic read, on purpose, because the cost of
 * admitting one agent too many (a box off the network, CI OOM-killed) is far
 * higher than the cost of one refusal that says exactly why.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import os from 'node:os'

/* What the kernel says is available right now, in MB, plus the swap figures.
 * Falls back to os.freemem() where there is no /proc (non-Linux dev only —
 * pessimistic there, since it excludes reclaimable cache), and to Infinity when
 * nothing is readable at all, so an unreadable box never blocks a spawn. */
export function readMemStatus() {
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8')
    const kb = (key) => {
      const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))
      return m ? Number(m[1]) : null
    }
    const avail = kb('MemAvailable')
    if (avail !== null) {
      const swapTotal = kb('SwapTotal') || 0
      const swapFree = kb('SwapFree') || 0
      return {
        availMb: Math.round(avail / 1024),
        swapTotalMb: Math.round(swapTotal / 1024),
        swapUsedMb: Math.round(Math.max(0, swapTotal - swapFree) / 1024),
      }
    }
  } catch {
    /* no /proc — fall through to the os fallback */
  }
  try {
    return { availMb: Math.round(os.freemem() / 1048576), swapTotalMb: 0, swapUsedMb: 0 }
  } catch {
    return { availMb: Infinity, swapTotalMb: 0, swapUsedMb: 0 }
  }
}

/* Availability after the swap charge (see the header). Infinity stays Infinity —
 * "unreadable" must not become "0 MB, refuse everything". */
export function effectiveAvailMb(mem, chargeSwap) {
  const avail = mem?.availMb
  if (!chargeSwap || !Number.isFinite(avail)) return avail
  return Math.max(0, avail - (mem.swapUsedMb || 0))
}

/* THE rule: room for one more agent on this box? Pure — the caller supplies the
 * live count, the limits and the memory reading, so it is the same decision
 * whether the numbers came from this box's /proc or from a bridge's /health.
 *
 * Returns the verdict AND every number that produced it, because a refusal that
 * doesn't say why is the same defect as a spawn that silently doesn't happen. */
export function capacityVerdict({ live, maxAgents, mem, floorMb, perAgentMb, chargeSwap = false }) {
  const effectiveMb = effectiveAvailMb(mem, chargeSwap)
  const needMb = floorMb + perAgentMb
  const memSlots = Number.isFinite(effectiveMb) ? Math.floor((effectiveMb - floorMb) / perAgentMb) : Infinity
  const reason = live >= maxAgents ? 'ceiling' : effectiveMb < needMb ? 'memory' : null
  return {
    ok: !reason,
    reason,
    live,
    maxAgents,
    availMb: mem?.availMb,
    swapUsedMb: mem?.swapUsedMb || 0,
    swapTotalMb: mem?.swapTotalMb || 0,
    effectiveMb,
    floorMb,
    perAgentMb,
    needMb,
    chargeSwap: !!chargeSwap,
    // What an orchestrator reads to see the limit BEFORE it hits it: how many
    // more agents this box would admit right now, by whichever bound is tighter.
    slots: Math.max(0, Math.min(maxAgents - live, memSlots)),
  }
}

/* The refusal, in words, with the arithmetic in it — shared so the box's
 * pre-flight refusal and the bridge's own refusal read identically (the operator
 * should not have to work out which layer said no from the phrasing). */
export function capacityMessage(where, v) {
  const mem = !Number.isFinite(v.availMb)
    ? 'memory unreadable'
    : v.chargeSwap && v.swapUsedMb
      ? `MemAvailable ${v.availMb} MB − ${v.swapUsedMb} MB already in swap = ${v.effectiveMb} MB effective`
      : `MemAvailable ${v.availMb} MB`
  return v.reason === 'ceiling'
    ? `${where} is at its agent ceiling: ${v.live}/${v.maxAgents} sessions live (${mem}). Finish or close an agent there, or raise that bridge's ceiling.`
    : `${where} is too low on memory for another agent: ${mem}, but a spawn needs ${v.needMb} MB (${v.floorMb} MB floor + ${v.perAgentMb} MB per agent) and ${v.live} session(s) are already live there. Finish or close an agent there first.`
}
