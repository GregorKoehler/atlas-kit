/* ------------------------------------------------------------------ *
 * Purging a torn-down child's undelivered notes from its PARENT's queue.
 *
 * The incident: an Atlas orchestrator ran one ~7 h turn while it spawned,
 * merged and cleaned up 8 dev agents. Every fleet note and turn-end line
 * observed during that turn was still parked in its queue when the turn ended,
 * and drained one per turn — about children the same chat had already merged
 * AND torn down. The parent either asked for the teardown or was told about it,
 * so anything still unsaid about that child is moot.
 *
 * ⚠️ A `reply-receipt` SURVIVES the purge: it answers a message the parent
 * actually sent, and "your message was answered" stays worth having after the
 * child is gone. Only the unsolicited observations go.
 *
 * flushQueued's delivery-time revalidation would drop these anyway (the child
 * is absent from the roster) — this is the up-front half, so the count is one
 * log line rather than N, and the notes never pad a digest.
 *
 * Run: node --test api/test/stale-note-teardown.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-purge-'))
process.env.AGENT_LOCAL_DIR = DIR
process.env.AGENT_LOCAL_RECONCILE = '0'
process.env.AGENT_LOCAL_DRIVE = '0'
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-purge-ws-'))
process.env.WORKSPACE_DIR = WORKSPACE

const HDR = '⚙ **Automatic fleet update from the Atlas Kit dashboard**'
const note = (kind, childId) => ({
  kind,
  at: '2027-01-15T09:00:00.000Z',
  observedAt: Date.parse('2027-01-15T09:00:00.000Z'),
  about: { childId },
  header: HDR,
  note: `${kind} about ${childId}`,
  text: `${HDR}\n\n${kind} about ${childId}`,
  steeredBy: 'system:fleet',
  source: 'system',
})

const chat = (id, queued) => ({
  id, kind: 'knowledge', vault: 'atlas', repo: 'demo', path: WORKSPACE,
  worktree: WORKSPACE, branch: 'main', tmux: `purge-test-${id}`,
  status: 'idle', startedAt: '2027-01-15T08:00:00Z', queued,
})

fs.writeFileSync(
  path.join(DIR, 'state.json'),
  JSON.stringify({
    sessions: {
      // The chat from the incident: two observations and one receipt about the
      // child being torn down, one observation about a DIFFERENT child, and an
      // operator prompt that has nothing to do with any of it.
      'orch-a': chat('orch-a', [
        note('fleet-note', 'kid-1'),
        { kind: 'operator', at: '2027-01-15T09:01:00.000Z', text: 'carry on' },
        note('turn-end', 'kid-1'),
        note('reply-receipt', 'kid-1'),
        note('fleet-note', 'kid-2'),
      ]),
      // A sibling chat whose ONLY queued entry is about the same child.
      'orch-b': chat('orch-b', [note('turn-end', 'kid-1')]),
    },
  }),
)

const local = await import('../src/agent-local.mjs')
// Read the PERSISTED state: the purge has to survive a restart to be worth
// anything (the queue it edits is the one reloaded from this file).
const queueOf = (id) => JSON.parse(fs.readFileSync(path.join(DIR, 'state.json'), 'utf-8')).sessions[id].queued

test('the two unsolicited observations go; the receipt and everything else stays', () => {
  assert.equal(local.purgeNotesAbout('kid-1'), 3, '2 in orch-a + 1 in orch-b')
  const q = queueOf('orch-a')
  assert.deepEqual(
    q.map((e) => e.kind),
    ['operator', 'reply-receipt', 'fleet-note'],
    'the receipt survives, so does the operator prompt and the note about the OTHER child',
  )
  assert.equal(q[2].about.childId, 'kid-2')
})

test('a queue emptied by the purge drops the field entirely (an empty array is not "queued")', () => {
  assert.equal(queueOf('orch-b'), undefined)
})

test('a child nobody has notes about changes nothing', () => {
  const before = JSON.stringify(queueOf('orch-a'))
  assert.equal(local.purgeNotesAbout('kid-never-seen'), 0)
  assert.equal(JSON.stringify(queueOf('orch-a')), before)
})

test('the purge is audited with its count — a silent purge would be indistinguishable from a lost note', () => {
  const lines = fs
    .readFileSync(path.join(DIR, 'audit.log'), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const purge = lines.filter((l) => l.action === 'queue-purge')
  assert.equal(purge.length, 1, 'exactly one line, and none for the no-op purge')
  assert.equal(purge[0].id, 'kid-1')
  assert.equal(purge[0].notes, 3)
})
