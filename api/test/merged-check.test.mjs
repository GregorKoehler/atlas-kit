/* ------------------------------------------------------------------ *
 * Tests for mergedVerdict/mergedFromPulls/mergedInfo (merged-check.mjs) — the
 * repo-derived "this agent's PR is merged" signal, so a card stops reading
 * `ready` when someone OTHER than the agent merged it.
 *
 * Pure decision logic over the two evidence sources — a `git log --merges
 * --format=%H|%P|%s` snapshot (box-local repos) and GitHub's closed-PR list
 * (bridge repos the box has no checkout of) — fixtures only, no real git and
 * no network.
 *
 * Run: node --test api/test/merged-check.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergedVerdict, mergedFromPulls, mergedInfo } from '../src/merged-check.mjs'

const TIP = '5424ad8d79a007acfa78d055be5ff8c430d9ba93'
const MID = '72fc985f4bcd74fb1d15d5fa313adfd9769121e4'
const MERGE = '159eac9730b65b027b894def9ba76cbbccfc110d'
// Real `git log --merges --format=%H|%P|%s` shape, newest first.
const LOG =
  `78fc48fd40cb33b178378073d12e8a3b59a6288b|${MID} a3a3d4f2f0a5cb9b32008e3d4024fb25ae87c0a6|Merge pull request #12 from example/agent/third\n` +
  `${MID}|${MERGE} eedd491f74a5802b0fc0a00573271decf66ee95f|Merge pull request #11 from example/agent/second\n` +
  `${MERGE}|e3e907b087fb17c72851e4806b611594ef25e891 ${TIP}|Merge pull request #10 from example/agent/first\n`

test("the branch tip as a merge commit's second parent → merged, with PR + merge SHA", () => {
  assert.deepEqual(mergedVerdict(TIP, LOG), { tip: TIP, sha: MERGE, pr: 10 })
})

test('a tip nothing merged → null (still waiting to be merged)', () => {
  assert.equal(mergedVerdict('a'.repeat(40), LOG), null)
})

test('empty log (the range has no merges at all) → null', () => {
  assert.equal(mergedVerdict(TIP, ''), null)
  assert.equal(mergedVerdict(TIP, '\n\n'), null)
  assert.equal(mergedVerdict(TIP, null), null)
})

test('no tip (branch gone / never resolved) → null, never a merged verdict', () => {
  assert.equal(mergedVerdict('', LOG), null)
  assert.equal(mergedVerdict(null, LOG), null)
})

test('a tip that is only a FIRST parent is NOT merged — that is the default branch itself', () => {
  // A freshly spawned agent branch sits on the default branch tip: it is an
  // ancestor of every later commit, and the next PR merge names it as parent 1.
  // This is precisely why `merge-base --is-ancestor` alone cannot be the test —
  // it would report every newly spawned agent as merged.
  assert.equal(mergedVerdict(MID, LOG.split('\n')[0]), null)
})

test('an octopus merge naming the tip beyond parent 2 still counts', () => {
  const out = `${MERGE}|p1 p2 ${TIP}|Merge pull requests #7, #8`
  assert.deepEqual(mergedVerdict(TIP, out), { tip: TIP, sha: MERGE, pr: 7 })
})

test('a merge with no PR number in its subject → merged, pr null', () => {
  const out = `${MERGE}|p1 ${TIP}|Merge branch 'agent/whatever'`
  assert.deepEqual(mergedVerdict(TIP, out), { tip: TIP, sha: MERGE, pr: null })
})

test('merged twice → the FIRST (oldest) merge is the one reported', () => {
  const out = `later|p1 ${TIP}|Merge pull request #99\n${MERGE}|p1 ${TIP}|Merge pull request #10`
  assert.equal(mergedVerdict(TIP, out).sha, MERGE)
})

test('malformed lines are skipped, not crashed on', () => {
  assert.equal(mergedVerdict(TIP, 'garbage\nno pipes here\n'), null)
  assert.deepEqual(mergedVerdict(TIP, `garbage\n${MERGE}|p1 ${TIP}|Merge pull request #10`).pr, 10)
})

test('mergedInfo — PR + short SHA, and the SHA alone when there is no PR', () => {
  assert.equal(mergedInfo({ tip: TIP, sha: MERGE, pr: 10 }), 'PR #10 merged as 159eac9')
  assert.equal(mergedInfo({ tip: TIP, sha: MERGE, pr: null }), 'merged as 159eac9')
  assert.equal(mergedInfo(null), '')
})

/* ── The same verdict for a repo the box has NO checkout of: GitHub's answer
      (agent-routes.mjs's remote merged-check), from the closed-PR list. ── */

test('a merged PR for the branch → its merge SHA + number', () => {
  const pulls = [{ number: 286, merged_at: '2026-07-28T16:38:43Z', merge_commit_sha: '7de7908' + 'a'.repeat(33) }]
  assert.deepEqual(mergedFromPulls(pulls), { sha: '7de7908' + 'a'.repeat(33), pr: 286 })
})

test('a CLOSED but unmerged PR is NOT merged — state is not the test, merged_at is', () => {
  assert.equal(mergedFromPulls([{ number: 9, state: 'closed', merged_at: null, merge_commit_sha: 'abc' }]), null)
})

test('no PRs for the branch → null (still waiting, or never opened)', () => {
  assert.equal(mergedFromPulls([]), null)
})

test('a non-array (API error object, null) → null, never a verdict', () => {
  assert.equal(mergedFromPulls({ message: 'Not Found' }), null)
  assert.equal(mergedFromPulls(null), null)
  assert.equal(mergedFromPulls(undefined), null)
})

test('several merged PRs on one branch → the oldest merge, the one that landed it', () => {
  const pulls = [
    { number: 20, merged_at: '2026-07-28T18:00:00Z', merge_commit_sha: 'later' },
    { number: 12, merged_at: '2026-07-28T09:00:00Z', merge_commit_sha: 'first' },
  ]
  assert.deepEqual(mergedFromPulls(pulls), { sha: 'first', pr: 12 })
})

test('a merged PR with no merge_commit_sha is skipped (nothing honest to show)', () => {
  assert.equal(mergedFromPulls([{ number: 5, merged_at: '2026-07-28T09:00:00Z', merge_commit_sha: null }]), null)
})
