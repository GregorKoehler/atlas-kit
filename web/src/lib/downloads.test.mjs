/* ------------------------------------------------------------------ *
 * Tests for the download-chip decisions (downloads.ts).
 *
 * The bug behind downloadRoute(): tapping a download chip in the INSTALLED
 * (home-screen) PWA navigates the app's one chrome-less webview to a non-HTML
 * response. The browser replaces the dashboard with its own file shim and — no
 * URL bar, no back button — the only way back is killing and relaunching the app.
 *
 * The first cut of this rescue saved IMAGES with an in-app overlay and left every
 * other type on `download` + `target="_blank"`, on the (untested, and written
 * down as untested) assumption that `_blank` would open a dismissible browser
 * overlay. Tested on a real installed PWA: an `.html` and a `.txt` each stranded
 * the app exactly as a bare anchor did. So these tests pin the INVARIANT rather
 * than the old split — no input may ever route a tap to an anchor in the
 * standalone webview.
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
  INLINE_MAX_BYTES,
  downloadRoute,
  previewKind,
  fmtBytes,
  lastDownloadedMtime,
  markDownloaded,
  updatedDownloads,
} from './downloads.ts'

/* The three browser facts the route reads. `PWA` is the failing case: the
 * installed standalone webview, where `download` is present in the DOM but
 * silently ignored — which is why `downloadHonoured` alone cannot gate it. */
const DESKTOP = { standalone: false, downloadHonoured: true }
const PWA = { standalone: true, downloadHonoured: true }
const ANCIENT = { standalone: false, downloadHonoured: false }
const f = (name, size = 1024) => ({ name, size })

const EVERY_TYPE = ['shot.png', 'report.html', 'note.txt', 'data.json', 'paper.pdf', 'bundle.zip', 'Dockerfile', '', 'x.png.zip']

// The module reads `localStorage` lazily (inside try/catch), so a plain stub is
// enough — no jsdom.
beforeEach(() => {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  }
})

/* --- THE INVARIANT ---------------------------------------------------- *
 * No tap, of any type, may leave the installed webview. This is the assertion
 * the previous shape could not make: it routed images in-app and everything else
 * to an anchor, and that anchor is what stranded the operator. */
test('THE INVARIANT: in the standalone PWA, NO file type routes a tap to an anchor', () => {
  for (const n of EVERY_TYPE) {
    assert.equal(downloadRoute(f(n), PWA).tap, 'overlay', `${n} must open in-app, never navigate`)
  }
  // …including a file too large to read into memory: it gets the no-preview
  // panel, which is still in-app and still dismissible.
  assert.equal(downloadRoute(f('huge.bin', 900 * 1024 * 1024), PWA).tap, 'overlay')
})

test('an anchor is allowed ONLY where `download` is honoured and we are not standalone', () => {
  // Desktop: unchanged from before — a real browser download for non-images.
  assert.equal(downloadRoute(f('note.txt'), DESKTOP).tap, 'anchor')
  assert.equal(downloadRoute(f('paper.pdf'), DESKTOP).tap, 'anchor')
  // …and images have always opened in-app there too. Keep that.
  assert.equal(downloadRoute(f('shot.png'), DESKTOP).tap, 'overlay')
  // No `download` support at all → in-app, rather than a navigation nobody has
  // proven safe. Every branch of `tap` ends in one of these two.
  assert.equal(downloadRoute(f('note.txt'), ANCIENT).tap, 'overlay')
})

test('previewKind: image / html / text / binary, case-insensitive and anchored at the end', () => {
  for (const n of ['shot.png', 'a.JPG', 'b.jpeg', 'c.gif', 'd.webp', 'e.avif', 'f.bmp', 'g.svg'])
    assert.equal(previewKind(n), 'image', n)
  for (const n of ['report.html', 'page.HTM', 'doc.xhtml']) assert.equal(previewKind(n), 'html', n)
  for (const n of ['note.txt', 'READ.md', 'data.json', 'rows.csv', 'run.log', 'c.yaml', 'x.diff'])
    assert.equal(previewKind(n), 'text', n)
  // No extension, an unknown one, or one that only LOOKS like a match → the
  // no-preview panel. Still in-app; just nothing to render.
  for (const n of ['paper.pdf', 'bundle.zip', 'Dockerfile', '', 'png', 'x.png.zip', 'html'])
    assert.equal(previewKind(n), 'binary', n)
  assert.equal(previewKind('SHOT.PNG'), 'image')
  assert.equal(previewKind('png.txt'), 'text')
})

test('oversize text/HTML degrades to the panel; an image never does (it renders from its URL)', () => {
  const big = INLINE_MAX_BYTES + 1
  assert.equal(downloadRoute(f('report.html', big), PWA).kind, 'binary')
  assert.equal(downloadRoute(f('note.txt', big), PWA).kind, 'binary')
  assert.equal(downloadRoute(f('note.txt', INLINE_MAX_BYTES), PWA).kind, 'text', 'the boundary is inclusive')
  assert.equal(downloadRoute(f('shot.png', big), PWA).kind, 'image')
  assert.equal(downloadRoute(f('shot.png', big), PWA).inline, false, 'but no share blob is pulled for it')
})

/* --- the save route --------------------------------------------------- *
 * Layer 1 is `navigator.share({files})` — NOT a blob plus `<a download>`, which
 * would still depend on the `download` attribute the standalone webview ignores;
 * share does not involve `download` in any way. */
test('share is the save route wherever a real download cannot be had', () => {
  assert.equal(downloadRoute(f('note.txt'), { ...PWA, canShareFiles: true }).save, 'share')
  assert.equal(downloadRoute(f('shot.png'), { ...PWA, canShareFiles: true }).save, 'share')
  assert.equal(downloadRoute(f('paper.pdf'), { ...PWA, canShareFiles: true }).save, 'share')
})

test('…but the ANCHOR outranks it on desktop, where a share dialog would be a regression', () => {
  // Desktop browsers answer canShare({files}) too. The operator expects the
  // download they have always had, so `download` wins wherever it is honoured.
  assert.equal(downloadRoute(f('shot.png'), { ...DESKTOP, canShareFiles: true }).save, 'anchor')
  assert.equal(downloadRoute(f('note.txt'), { ...DESKTOP, canShareFiles: true }).save, 'anchor')
  // …and the desktop image overlay therefore needs no blob at all: it renders
  // from the URL and saves with the anchor, one request, exactly as before.
  assert.equal(downloadRoute(f('shot.png'), DESKTOP).prefetch, false)
  // Standalone always needs the bytes — to render, or to ask canShare at all.
  assert.equal(downloadRoute(f('shot.png'), PWA).prefetch, true)
  assert.equal(downloadRoute(f('paper.pdf'), PWA).prefetch, true)
  assert.equal(downloadRoute(f('huge.pdf', 900 * 1024 * 1024), PWA).prefetch, false, 'never for an oversize file')
})

test('canShare false must fall through to a STATED dead end, never to a navigation', () => {
  // The share sheet filters by MIME type, so this is a real branch, not a theory.
  assert.equal(downloadRoute(f('note.txt'), PWA).save, 'none')
  assert.equal(downloadRoute(f('bundle.zip'), PWA).save, 'none')
  // An image still has the one save route that never leaves the app.
  assert.equal(downloadRoute(f('shot.png'), PWA).save, 'longpress')
  // Desktop keeps the plain download it has always had.
  assert.equal(downloadRoute(f('note.txt'), DESKTOP).save, 'anchor')
  assert.equal(downloadRoute(f('shot.png'), DESKTOP).save, 'anchor')
})

test('`tap` never reads canShareFiles — it is decided before the blob exists', () => {
  for (const n of EVERY_TYPE) {
    for (const env of [DESKTOP, PWA, ANCIENT]) {
      assert.equal(
        downloadRoute(f(n), env).tap,
        downloadRoute(f(n), { ...env, canShareFiles: true }).tap,
        `${n}: the chip must decide the same with or without a share verdict`,
      )
    }
  }
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
