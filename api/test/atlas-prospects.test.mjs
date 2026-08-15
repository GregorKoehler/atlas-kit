/* ------------------------------------------------------------------ *
 * Tests for atlas-prospects.mjs — the Task Prospects server-side store.
 *
 * Focus: the STICKY decision guarantee — a source already decided, approved OR
 * rejected, is never re-queued by a later propose() call, even though the
 * pending queue itself only ever holds ONE entry per sourceKey at a time. That
 * is what stops a producer that re-notices the same follow-up work (a dev agent
 * that hits the same rough edge on every run) from re-proposing something the
 * operator already dismissed. Pure module state (no vault, no git) — this is
 * dashboard metadata, not knowledge.
 *
 * Run: node --test api/test/atlas-prospects.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// STATE_FILE is frozen into atlas-prospects.mjs at its first import — point it
// at a throwaway file BEFORE that import.
process.env.ATLAS_PROSPECTS_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-prospects-')),
  'atlas-prospects.json',
)

const { addProspect, listProspects, resolveProspect, decisionFor } = await import('../src/atlas-prospects.mjs')

test('addProspect: files a pending prospect and returns its id', () => {
  const r = addProspect({ title: 'Add a retry to the vault sync', body: 'it fails on a slow push', producer: 'dev-agent' })
  assert.equal(r.ok, true)
  assert.ok(r.id)
  const p = listProspects().find((x) => x.id === r.id)
  assert.equal(p.title, 'Add a retry to the vault sync')
  assert.equal(p.body, 'it fails on a slow push')
  assert.equal(p.producer, 'dev-agent')
  assert.equal(p.sourceKey, null)
})

test('sticky decision: propose -> reject -> re-propose the SAME source -> never re-queued', () => {
  const key = 'dev-agent:flaky-vault-push'
  const first = addProspect({ title: 'Add a retry to the vault sync', sourceKey: key })
  assert.equal(first.ok, true)

  const rejected = resolveProspect(first.id, 'rejected')
  assert.equal(rejected.id, first.id)
  assert.equal(listProspects().some((p) => p.id === first.id), false, 'removed from the pending queue on reject')
  assert.equal(decisionFor(key), 'rejected')

  // The next run hits the same rough edge and proposes again — this is the exact
  // scenario the sticky guarantee exists for.
  const again = addProspect({ title: 'Add a retry to the vault sync (re-worded)', sourceKey: key })
  assert.equal(again.ok, false)
  assert.equal(again.skipped, 'decided')
  assert.equal(again.decision, 'rejected')
  assert.equal(listProspects().some((p) => p.sourceKey === key), false, 'still nothing queued for this source')
})

test('sticky decision: an APPROVED source is also never re-queued', () => {
  const key = 'dev-agent:bridge-timeout-knob'
  const first = addProspect({ title: 'Make the bridge timeout configurable', sourceKey: key })
  resolveProspect(first.id, 'approved')
  assert.equal(decisionFor(key), 'approved')

  const again = addProspect({ title: 'Make the bridge timeout configurable (duplicate)', sourceKey: key })
  assert.equal(again.ok, false)
  assert.equal(again.skipped, 'decided')
  assert.equal(again.decision, 'approved')
})

test('a source already pending is not queued twice (dedup against the live queue, not just decided sources)', () => {
  const key = 'dev-agent:kanban-empty-state'
  const first = addProspect({ title: 'Kanban needs an empty state', sourceKey: key })
  assert.equal(first.ok, true)

  const second = addProspect({ title: 'Kanban needs an empty state (re-worded)', sourceKey: key })
  assert.equal(second.ok, false)
  assert.equal(second.skipped, 'duplicate')
  assert.equal(listProspects().filter((p) => p.sourceKey === key).length, 1)
})

test('resolveProspect on an unknown id returns null and touches nothing', () => {
  assert.equal(resolveProspect('does-not-exist', 'rejected'), null)
})

test('decisionFor: null sourceKey, or one never decided, resolves to null', () => {
  assert.equal(decisionFor(null), null)
  assert.equal(decisionFor('dev-agent:never-seen'), null)
})
