/* ------------------------------------------------------------------ *
 * Tests for the boot self-heal's RE-ATTACH decision (planReattach /
 * runReattach in agent-local.mjs) — what a restart does to a running fleet.
 *
 * The behaviour this pins, and why each half matters:
 *   • re-attach, don't park: after a restart (a Redeploy, a reboot) the agents
 *     that were alive come back on their own — parking every one of them behind
 *     a "revive N dormant" button is the thing this replaces;
 *   • bounded, because the box is RAM-bound: newest first, capped at the room
 *     left under the concurrency ceiling, staggered between launches;
 *   • and the REMAINDER STAYS PARKED — over the cap, past the memory floor, or a
 *     failed resume all land as 'dormant', so the Revive button remains the
 *     fallback and a low-memory box degrades instead of OOM-spiralling.
 *
 * Hermetic: the decision layer takes injected `memOk` / `launch`, so no tmux, no
 * `claude`, no real memory pressure. State/workspace dirs are pinned to temp
 * dirs and the boot reconciler is disabled before importing the module.
 *
 * Run: node --test api/test/agent-boot-reattach.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.AGENT_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-reattach-'))
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-reattach-ws-'))
process.env.AGENT_LOCAL_RECONCILE = '0' // don't run the real boot pass under test
process.env.AGENT_LOCAL_DRIVE = '0'

const { planReattach, runReattach } = await import('../src/agent-local.mjs')

// Sessions as the reconciler sees them: an id and when they were spawned.
const sess = (id, startedAt) => ({ id, startedAt, repo: 'demo', kind: 'dev' })
const ids = (list) => list.map((s) => s.id)
const FLEET = [
  sess('a', '2026-08-15T09:00:00Z'),
  sess('b', '2026-08-15T11:00:00Z'),
  sess('c', '2026-08-15T10:00:00Z'),
]

test('plan: newest first, capped — everything past the cap parks', () => {
  const { reattach, park } = planReattach(FLEET, { max: 2 })
  assert.deepEqual(ids(reattach), ['b', 'c'], 'the two most recent come back first')
  assert.deepEqual(ids(park), ['a'], 'the oldest waits for the Revive button')
})

test('plan: no room under the ceiling → nothing re-attaches, nothing is lost', () => {
  const { reattach, park } = planReattach(FLEET, { max: 0 })
  assert.deepEqual(ids(reattach), [])
  assert.deepEqual(ids(park).sort(), ['a', 'b', 'c'], 'all three stay revivable')
  // A negative cap (more alive than the ceiling allows) must behave the same.
  assert.deepEqual(ids(planReattach(FLEET, { max: -2 }).reattach), [])
})

test('every planned session is either re-attached or parked — never dropped', async () => {
  const { attached, park } = await runReattach(FLEET, {
    max: 2,
    memOk: () => true,
    launch: async () => true,
  })
  assert.deepEqual([...ids(attached), ...ids(park)].sort(), ['a', 'b', 'c'])
})

test('the memory floor parks the WHOLE remainder, and stops launching', async () => {
  const launched = []
  let calls = 0
  const { attached, park } = await runReattach(FLEET, {
    max: 3,
    // Room for exactly one, then the box is full.
    memOk: () => ++calls <= 1,
    launch: async (s) => {
      launched.push(s.id)
      return true
    },
  })
  assert.deepEqual(launched, ['b'], 'only the one that fit was launched')
  assert.deepEqual(ids(attached), ['b'])
  assert.deepEqual(ids(park).sort(), ['a', 'c'], 'the rest stay dormant for the Revive button')
})

test('a refused floor on the FIRST check parks everything (the old behaviour)', async () => {
  const { attached, park } = await runReattach(FLEET, {
    max: 3,
    memOk: () => false,
    launch: async () => {
      throw new Error('must not launch on a full box')
    },
  })
  assert.deepEqual(attached, [])
  assert.deepEqual(ids(park).sort(), ['a', 'b', 'c'])
})

test('a resume that fails parks that one and keeps going', async () => {
  const { attached, park } = await runReattach(FLEET, {
    max: 3,
    memOk: () => true,
    launch: async (s) => s.id !== 'c', // c has no usable transcript, say
  })
  assert.deepEqual(ids(attached), ['b', 'a'])
  assert.deepEqual(ids(park), ['c'], 'a failed resume is dormant, not lost')
})

test('launches are staggered — but never after the last one', async () => {
  const waits = []
  const t0 = Date.now()
  await runReattach(FLEET, {
    max: 3,
    memOk: () => true,
    launch: async () => {
      waits.push(Date.now() - t0)
      return true
    },
    stagger: 25,
  })
  assert.equal(waits.length, 3)
  assert.ok(waits[1] >= 20, `second launch waited (${waits[1]}ms)`)
  assert.ok(waits[2] >= 45, `third launch waited again (${waits[2]}ms)`)
  // The stagger after the final launch would be pure boot latency.
  assert.ok(Date.now() - t0 < 200, 'no trailing sleep')
})
