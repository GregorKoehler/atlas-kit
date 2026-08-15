/* ------------------------------------------------------------------ *
 * Tests for the download-chip decisions (downloads.ts).
 *
 * The bug behind isPreviewable(): tapping a download chip in the INSTALLED
 * (home-screen) PWA used to navigate the app's one chrome-less webview to a
 * non-HTML response. iOS replaced the dashboard with its own file shim and —
 * no URL bar, no back button — the only way back was killing and relaunching
 * the app. This predicate decides who gets rescued by the in-app overlay
 * instead (images: an <img> is a subresource, so no server change is needed)
 * and who takes the non-navigating hand-off.
 *
 * Also pins the ONE seen-rule the badge follows, now that opening a preview
 * counts as having seen a version just as downloading does.
 *
 * Runs the real TS module via node's native type-stripping (no build, no
 * node_modules): downloads.ts is self-contained.
 * Run: node --test web/src/lib/downloads.test.mjs
 * ------------------------------------------------------------------ */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  isPreviewable,
  fmtBytes,
  lastDownloadedMtime,
  markDownloaded,
  updatedDownloads,
} from './downloads.ts'

// The module reads `localStorage` lazily (inside try/catch), so a plain stub is
// enough — no jsdom.
beforeEach(() => {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  }
})

test('images preview in-app — that is the whole mobile rescue', () => {
  for (const n of ['shot.png', 'a.JPG', 'b.jpeg', 'c.gif', 'd.webp', 'e.avif', 'f.bmp', 'g.svg']) {
    assert.equal(isPreviewable(n), true, `${n} should preview`)
  }
})

test('everything else takes the non-navigating hand-off, PDFs included', () => {
  // A PDF needs a real navigation to render, which the route's attachment
  // disposition turns back into a download — so it is deliberately NOT previewable.
  for (const n of ['report.pdf', 'data.csv', 'notes.md', 'bundle.zip', 'Dockerfile', '', 'png', 'x.png.zip']) {
    assert.equal(isPreviewable(n), false, `${n} should not preview`)
  }
})

test('the extension test is case-insensitive and anchored at the end', () => {
  assert.equal(isPreviewable('SHOT.PNG'), true)
  assert.equal(isPreviewable('png.txt'), false)
})

test('fmtBytes scales B / KB / MB', () => {
  assert.equal(fmtBytes(0), '0 B')
  assert.equal(fmtBytes(1023), '1023 B')
  assert.equal(fmtBytes(1024), '1.0 KB')
  assert.equal(fmtBytes(1536), '1.5 KB')
  assert.equal(fmtBytes(2 * 1024 * 1024), '2.0 MB')
})

test('a file never seen is flagged as updated', () => {
  const files = [{ name: 'shot.png', size: 10, mtime: 500 }]
  assert.deepEqual([...updatedDownloads('a1', files)], ['shot.png'])
  assert.equal(lastDownloadedMtime('a1', 'shot.png'), 0)
})

test('THE SEEN RULE: marking a version clears the badge; a newer write brings it back', () => {
  const at = (mtime) => [{ name: 'shot.png', size: 10, mtime }]
  // Opening the preview (or downloading — same call, deliberately) marks it seen.
  markDownloaded('a1', 'shot.png', 500)
  assert.equal(updatedDownloads('a1', at(500)).size, 0, 'the version just seen must not be badged')
  assert.deepEqual([...updatedDownloads('a1', at(900))], ['shot.png'], 'a newer write re-badges')
  // Re-seeing the SAME version keeps it clear (no badge for a repeat open).
  markDownloaded('a1', 'shot.png', 900)
  assert.equal(updatedDownloads('a1', at(900)).size, 0)
})

test('the record is scoped per (session, filename)', () => {
  markDownloaded('a1', 'shot.png', 500)
  const files = [{ name: 'shot.png', size: 10, mtime: 500 }]
  assert.equal(updatedDownloads('a1', files).size, 0)
  assert.equal(updatedDownloads('a2', files).size, 1, "another agent's file of the same name is untouched")
  assert.equal(updatedDownloads('a1', [{ name: 'other.png', size: 1, mtime: 500 }]).size, 1)
})

/* The full-screen head's collapsed "⬇ N" chip shows ONE dot for the whole set,
 * and it is exactly `updatedDownloads(...).size > 0` over the same rule the
 * per-file chips use — no second notion of "updated" that could drift from the
 * strip's. These pin the three answers the chip depends on. */
test('THE CHIP DOT: on while ANY file is unseen, off once the last one is seen', () => {
  const files = [
    { name: 'a.png', size: 1, mtime: 100 },
    { name: 'b.pdf', size: 2, mtime: 200 },
  ]
  assert.equal(updatedDownloads('a1', files).size, 2, 'both new → dot on')
  markDownloaded('a1', 'a.png', 100)
  assert.equal(updatedDownloads('a1', files).size, 1, 'one still unseen → dot stays on')
  markDownloaded('a1', 'b.pdf', 200)
  assert.equal(updatedDownloads('a1', files).size, 0, 'nothing unseen → dot off')
  // A newer write to either file brings the aggregate dot straight back.
  assert.equal(updatedDownloads('a1', [{ name: 'b.pdf', size: 2, mtime: 300 }]).size, 1)
})

test('no files ⇒ nothing to badge (the chip renders nothing at all in that case)', () => {
  assert.equal(updatedDownloads('a1', []).size, 0)
})

test('a localStorage that throws (private mode) degrades to "everything is new", never a crash', () => {
  globalThis.localStorage = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('denied')
    },
  }
  markDownloaded('a1', 'shot.png', 500)
  assert.equal(lastDownloadedMtime('a1', 'shot.png'), 0)
  assert.equal(updatedDownloads('a1', [{ name: 'shot.png', size: 1, mtime: 500 }]).size, 1)
})
