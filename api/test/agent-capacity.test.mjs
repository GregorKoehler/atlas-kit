/* ------------------------------------------------------------------ *
 * ONE spawn-admission rule, for the box AND for the bridge boxes.
 *
 * The gap this guards: `atCapacity()` (the MAX_LIVE ceiling + the RAM gate)
 * lived in agent-local.mjs and was called from that file only, so it protected
 * the DASHBOARD box while the remote path put an unbounded number of agents onto
 * someone else's. A bridge box is usually not a dedicated agent host — it may
 * also run production, a CI runner and per-PR preview stacks — so it is exactly
 * the box that needs a brake, and it was the one box that had none.
 *
 * Three things are pinned here, and each is a way the fix could rot:
 *  1. the RULE is arithmetic, and the swap charge is the load-bearing part of it
 *     — MemAvailable ALONE says a box deep in swap is fine;
 *  2. all three gates call the SAME implementation (a second copy drifts, and
 *     only one copy gets maintained);
 *  3. the box-local path keeps its exact previous behaviour — this change adds a
 *     gate to the remote path, it does not retune the local one.
 *
 * Run: node --test api/test/agent-capacity.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { capacityVerdict, capacityMessage, effectiveAvailMb, readMemStatus } from '../src/agent-capacity.mjs'

const LIMITS = { floorMb: 1200, perAgentMb: 500 }
// A real reading off a box that was drowning: ~4 GB "available" with ~3.5 GB of
// anonymous pages already pushed to swap.
const DROWNING = { availMb: 4021, swapUsedMb: 3512, swapTotalMb: 4096 }

/* --- 1. the number the gate reads ------------------------------------ */

test('the swap charge is what makes the drowning box read as drowning', () => {
  const naive = capacityVerdict({ live: 7, maxAgents: 12, mem: DROWNING, ...LIMITS, chargeSwap: false })
  assert.equal(naive.ok, true, 'MemAvailable alone says 4 GB free — this is the reading that admits an eighth agent')

  const charged = capacityVerdict({ live: 7, maxAgents: 12, mem: DROWNING, ...LIMITS, chargeSwap: true })
  assert.equal(charged.ok, false)
  assert.equal(charged.reason, 'memory')
  assert.equal(charged.effectiveMb, 509, '4021 − 3512: the pages in swap must fault back in when those agents take a turn')
  assert.equal(charged.slots, 0)
})

test('MemAvailable, never MemFree — the kernel\'s own estimate, so page cache is not "used"', () => {
  let raw
  try {
    raw = fs.readFileSync('/proc/meminfo', 'utf8')
  } catch {
    return // no /proc (non-Linux dev) — the fallback path is asserted below
  }
  const kb = (k) => Number(raw.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))[1])
  const m = readMemStatus()
  assert.equal(m.availMb, Math.round(kb('MemAvailable') / 1024))
  assert.equal(m.swapTotalMb, Math.round(kb('SwapTotal') / 1024))
  assert.equal(m.swapUsedMb, Math.round(Math.max(0, kb('SwapTotal') - kb('SwapFree')) / 1024))
  if (kb('MemFree') !== kb('MemAvailable'))
    assert.notEqual(
      m.availMb,
      Math.round(kb('MemFree') / 1024),
      'a busy box is full of reclaimable cache; MemFree would refuse spawns it should admit',
    )
})

test('an unreadable box never blocks a spawn — Infinity stays Infinity, it does not become 0', () => {
  const unknown = { availMb: Infinity, swapUsedMb: 0, swapTotalMb: 0 }
  assert.equal(effectiveAvailMb(unknown, true), Infinity)
  const v = capacityVerdict({ live: 0, maxAgents: 8, mem: unknown, ...LIMITS, chargeSwap: true })
  assert.equal(v.ok, true)
  assert.equal(v.slots, 8, 'the count ceiling is still a bound when memory is unknowable')
})

/* --- 2. the rule --------------------------------------------------- */

test('the ceiling and the memory floor are both bounds, and the tighter one wins', () => {
  const roomy = { availMb: 8000, swapUsedMb: 0, swapTotalMb: 0 }
  // (8000 − 1200) / 500 = 13 memory slots, but only 2 left under the ceiling.
  assert.equal(capacityVerdict({ live: 6, maxAgents: 8, mem: roomy, ...LIMITS, chargeSwap: true }).slots, 2)
  // 8 live of 8 → refused on the count, whatever the memory says.
  const full = capacityVerdict({ live: 8, maxAgents: 8, mem: roomy, ...LIMITS, chargeSwap: true })
  assert.equal(full.ok, false)
  assert.equal(full.reason, 'ceiling')
  // Room in the count, no room in RAM → refused on memory.
  const tight = capacityVerdict({ live: 1, maxAgents: 8, mem: { availMb: 1500, swapUsedMb: 0, swapTotalMb: 0 }, ...LIMITS, chargeSwap: true })
  assert.equal(tight.ok, false)
  assert.equal(tight.reason, 'memory')
  assert.equal(tight.needMb, 1700, "floor + ONE agent's headroom — the agent we admit has to be able to grow")
  assert.equal(tight.slots, 0)
})

test('the refusal carries the arithmetic that produced it', () => {
  const v = capacityVerdict({ live: 7, maxAgents: 8, mem: DROWNING, ...LIMITS, chargeSwap: true })
  const msg = capacityMessage('lab-box', v)
  assert.match(msg, /lab-box/)
  assert.match(msg, /4021 MB − 3512 MB already in swap = 509 MB effective/)
  assert.match(msg, /needs 1700 MB/)
  assert.match(msg, /7 session\(s\) are already live/)
  const ceiling = capacityMessage('lab-box', capacityVerdict({ live: 8, maxAgents: 8, mem: DROWNING, ...LIMITS, chargeSwap: true }))
  assert.match(ceiling, /8\/8 sessions live/)
})

/* --- 3. one implementation, three gates ------------------------------ */

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf-8')
const bridgeSrc = read('../../agent-bridge/server.mjs')
const localSrc = read('../src/agent-local.mjs')
const routesSrc = read('../src/agent-routes.mjs')
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

test('all three gates import the shared rule instead of re-deriving it', () => {
  assert.match(bridgeSrc, /import \{ capacityVerdict, capacityMessage, readMemStatus \} from '\.\.\/api\/src\/agent-capacity\.mjs'/)
  assert.match(localSrc, /import \{ capacityVerdict, readMemStatus \} from '\.\/agent-capacity\.mjs'/)
  assert.match(routesSrc, /import \{ capacityVerdict, capacityMessage \} from '\.\/agent-capacity\.mjs'/)
  // The old private /proc parse in agent-local.mjs is GONE, not shadowed by a copy.
  assert.doesNotMatch(code(localSrc), /MemAvailable/, 'one place reads /proc, and it is agent-capacity.mjs')
  assert.doesNotMatch(code(bridgeSrc), /MemAvailable|freemem/)
  assert.doesNotMatch(code(routesSrc), /MemAvailable|freemem/)
})

test('the bridge refuses on its own box, BEFORE it creates anything', () => {
  const start = bridgeSrc.indexOf('async function spawn({')
  const end = bridgeSrc.indexOf('\n// Shared front half of prompt/interrupt/queue', start)
  assert.ok(start > 0 && end > start)
  const spawnFn = bridgeSrc.slice(start, end)
  const gate = spawnFn.indexOf('const cap = agentCapacity()')
  const worktree = spawnFn.indexOf("'worktree', 'add'")
  assert.ok(gate > 0, 'the bridge must apply the gate itself — an API-side check alone trusts a stale reading and misses direct calls')
  assert.ok(worktree > gate, 'refuse before a worktree, a port or a container file exists')
  assert.match(spawnFn.slice(gate, worktree), /status: 503, ok: false, error, capacity: cap/)
  assert.match(
    spawnFn.slice(gate, worktree),
    /audit\(\{ action: 'spawn', repo, ok: false, error, capacity: cap \}\)/,
    'a refusal is a logged event, not a silence',
  )
})

test('the box-local path is untouched: same two messages, same env knobs, no swap charge', () => {
  const start = localSrc.indexOf('async function atCapacity()')
  const fn = localSrc.slice(start, localSrc.indexOf('\nfunction availMemMb()', start))
  assert.match(fn, /box at agent capacity \(\$\{v\.live\}\/\$\{v\.maxAgents\} live\) — close one or raise AGENT_LOCAL_MAX_CONCURRENT/)
  assert.match(fn, /box low on memory \(\$\{v\.availMb\} MB free\) — close an agent first, then spawn/)
  assert.match(fn, /chargeSwap: false/, 'a control-plane box may run permanently in swap by design — charging it here is a separate, measured change')
  assert.match(localSrc, /const MAX_LIVE = Number\(process\.env\.AGENT_LOCAL_MAX_CONCURRENT \|\| 12\)/)
  assert.match(localSrc, /const REVIVE_MEM_FLOOR_MB = Number\(process\.env\.AGENT_LOCAL_REVIVE_MEM_FLOOR_MB \|\| 1200\)/)
  assert.match(localSrc, /const REVIVE_MEM_PER_AGENT_MB = Number\(process\.env\.AGENT_LOCAL_REVIVE_MEM_PER_AGENT_MB \|\| 500\)/)
})

test('the bridge box gets its own limits — lower ceiling, same floor, swap charged by default', () => {
  assert.match(bridgeSrc, /const AGENT_MAX_LIVE = Number\(process\.env\.BRIDGE_AGENT_MAX_CONCURRENT \|\| 8\)/)
  assert.match(bridgeSrc, /const AGENT_MEM_FLOOR_MB = Number\(process\.env\.BRIDGE_AGENT_MEM_FLOOR_MB \|\| 1200\)/)
  assert.match(bridgeSrc, /const AGENT_MEM_PER_AGENT_MB = Number\(process\.env\.BRIDGE_AGENT_MEM_PER_AGENT_MB \|\| 500\)/)
  assert.match(bridgeSrc, /const AGENT_MEM_CHARGE_SWAP = !\/\^\(0\|false\|no\|off\)\$\/i\.test\(process\.env\.BRIDGE_AGENT_MEM_CHARGE_SWAP \|\| '1'\)/)
  // Reported on the channel the box ALREADY polls — no new endpoint, no heartbeat.
  assert.match(bridgeSrc, /p === '\/health'\) \{[\s\S]{0,1400}?capacity: agentCapacity\(\)/)
  // The live count must not cost a docker exec per session on a box that is, by
  // hypothesis, already too busy to answer.
  const cnt = bridgeSrc.slice(bridgeSrc.indexOf('function liveSessionCount()'), bridgeSrc.indexOf('function agentCapacity()'))
  assert.match(cnt, /registry\.sessions/)
  assert.doesNotMatch(cnt, /dockerExec|sessionAlive/)
})
