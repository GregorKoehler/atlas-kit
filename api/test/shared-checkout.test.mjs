/* ------------------------------------------------------------------ *
 * Tests for sharedCheckoutWarning (shared-checkout.mjs) — the ship-time guard
 * that warns when a repo's SHARED checkout isn't clean at its upstream (the
 * tell for a dev agent that worked there instead of in its worktree).
 *
 * Pure decision logic over a `git status --porcelain -b` snapshot: fixtures
 * only, no real git.
 *
 * Run: node --test api/test/shared-checkout.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sharedCheckoutWarning } from '../src/shared-checkout.mjs'

const REPO = '/srv/demo-app'
const ok = (stdout) => ({ ok: true, stdout })

test('clean and at its upstream → no warning', () => {
  assert.equal(sharedCheckoutWarning(REPO, ok('## main...origin/main\n')), null)
})

test('modified tracked files → warns with the change count', () => {
  const w = sharedCheckoutWarning(REPO, ok('## main...origin/main\n M api/src/x.mjs\nM  CLAUDE.md\n'))
  assert.match(w, /\/srv\/demo-app/)
  assert.match(w, /2 uncommitted changes/)
})

test('one modified file → singular', () => {
  const w = sharedCheckoutWarning(REPO, ok('## main...origin/main\n M api/src/x.mjs\n'))
  assert.match(w, /1 uncommitted change\b/)
})

test('untracked files ALONE → silent (build/log cruft next to a running service)', () => {
  assert.equal(sharedCheckoutWarning(REPO, ok('## main...origin/main\n?? caddy/\n?? err.log\n')), null)
})

test('untracked files are reported once something else has fired', () => {
  const w = sharedCheckoutWarning(REPO, ok('## main...origin/main\n M CLAUDE.md\n?? err.log\n'))
  assert.match(w, /1 uncommitted change; 1 untracked file/)
})

test('diverged — local commits not pushed → warns', () => {
  const w = sharedCheckoutWarning(REPO, ok('## main...origin/main [ahead 2]\n'))
  assert.match(w, /2 local commits on `main` not in origin\/main/)
})

test('behind only → silent (normal between a merge and the next deploy pull)', () => {
  assert.equal(sharedCheckoutWarning(REPO, ok('## main...origin/main [behind 3]\n')), null)
})

test('ahead AND behind → still warns about the local commits', () => {
  const w = sharedCheckoutWarning(REPO, ok('## main...origin/main [ahead 1, behind 3]\n'))
  assert.match(w, /1 local commit on `main` not in origin\/main/)
})

test('a stray branch with no upstream → warns', () => {
  const w = sharedCheckoutWarning(REPO, ok('## agent/some-slip\n'))
  assert.match(w, /`agent\/some-slip`, which tracks nothing/)
})

test('detached HEAD → warns', () => {
  assert.match(sharedCheckoutWarning(REPO, ok('## HEAD (no branch)\n')), /detached HEAD/)
})

test('dirty AND ahead → both issues in one line', () => {
  const w = sharedCheckoutWarning(REPO, ok('## main...origin/main [ahead 1]\n M CLAUDE.md\n'))
  assert.match(w, /1 uncommitted change; 1 local commit/)
})

test('path missing / git failed → null (nothing honest to say)', () => {
  assert.equal(sharedCheckoutWarning('/nope', { ok: false, stdout: '' }), null)
  assert.equal(sharedCheckoutWarning('/nope', null), null)
})

test('the repo path is never hardcoded — it comes from the caller', () => {
  // The guard against this module ever growing a baked-in operator path: the
  // warning must name the path it was GIVEN, and nothing else.
  const w = sharedCheckoutWarning('/opt/other-repo', ok('## main...origin/main\n M a.txt\n'))
  assert.match(w, /\/opt\/other-repo/)
  assert.doesNotMatch(w, /\/srv\/demo-app|\/workspace/)
})
