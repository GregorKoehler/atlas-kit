/* ------------------------------------------------------------------ *
 * Tests for the agent-exposed download channel (agent-local.mjs).
 *
 * Focus:
 *  - listDownloads() shape: {name, size, mtime}[], dotfiles + subdirs skipped.
 *  - downloadFile() name sanitization: rejects traversal (`../`), absolute
 *    paths, bare `.`/`..`, and any name carrying a path separator — all via
 *    the same "must equal its own basename" check.
 *  - downloadFile() only serves a name that's actually in the listing (a
 *    session with no downloads dir, or a name that doesn't exist, 404s).
 *  - the KNOWLEDGE spawn attachment round trip: saveImages() writes the files,
 *    knowledgePrompt() folds their paths into the opening question, and a spawn
 *    with NO attachments stays byte-identical to the old prompt. Plus the route
 *    wiring that carried them — the knowledge branch used to drop `images` on
 *    the floor, silently.
 *
 * Run: node --test api/test/agent-downloads.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-downloads-local-'))

// State fixture written BEFORE import (the module loads state.json at load time).
const fixture = {
  sessions: {
    'has-downloads': {
      id: 'has-downloads',
      kind: 'dev',
      repo: 'widget',
      branch: 'agent/has-downloads',
      tmux: 'agentbox-has-downloads',
      worktree: path.join(dir, 'wt'),
      status: 'idle',
      startedAt: '2026-07-01T00:00:00.000Z',
    },
    'no-downloads': {
      id: 'no-downloads',
      kind: 'dev',
      repo: 'widget',
      branch: 'agent/no-downloads',
      tmux: 'agentbox-no-downloads',
      worktree: path.join(dir, 'wt2'),
      status: 'idle',
      startedAt: '2026-07-01T00:01:00.000Z',
    },
  },
}
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(fixture))

// A downloads dir for 'has-downloads' with a real file, a dotfile (skipped)
// and a subdirectory (skipped — listDownloads only lists files).
const dlDir = path.join(dir, 'downloads', 'has-downloads')
fs.mkdirSync(dlDir, { recursive: true })
fs.writeFileSync(path.join(dlDir, 'report.pdf'), 'PDF-DATA')
fs.writeFileSync(path.join(dlDir, '.hidden'), 'nope')
fs.mkdirSync(path.join(dlDir, 'a-subdir'))

process.env.AGENT_LOCAL_DIR = dir
process.env.WORKSPACE_DIR = dir
process.env.AGENT_LOCAL_RECONCILE = '0' // keep the boot reconciler quiet in the test

const local = await import('../src/agent-local.mjs')

test('listDownloads() lists files with the {name, size, mtime} shape, skipping dotfiles + subdirs', () => {
  const files = local.listDownloads('has-downloads')
  assert.equal(files.length, 1, 'the dotfile and the subdirectory must not be listed')
  const [f] = files
  assert.equal(f.name, 'report.pdf')
  assert.equal(f.size, Buffer.byteLength('PDF-DATA'))
  assert.equal(typeof f.mtime, 'number')
  assert.ok(f.mtime > 0)
})

test('listDownloads() returns an empty array for a session with no downloads dir', () => {
  assert.deepEqual(local.listDownloads('no-downloads'), [])
})

test('downloadFile() serves a real file with its resolved path', () => {
  const r = local.downloadFile({ id: 'has-downloads', name: 'report.pdf' })
  assert.equal(r.status, 200)
  assert.equal(r.ok, true)
  assert.equal(r.name, 'report.pdf')
  assert.equal(r.path, path.join(dlDir, 'report.pdf'))
})

test('downloadFile() 404s for an unknown session id', () => {
  const r = local.downloadFile({ id: 'no-such-agent', name: 'report.pdf' })
  assert.equal(r.status, 404)
  assert.equal(r.ok, false)
})

test('downloadFile() 404s for a name not in the current listing', () => {
  const r = local.downloadFile({ id: 'has-downloads', name: 'nope.pdf' })
  assert.equal(r.status, 404)
  assert.equal(r.ok, false)
})

test('downloadFile() rejects traversal, absolute paths, and bare dots', () => {
  const bad = ['../report.pdf', '../../etc/passwd', '/etc/passwd', 'sub/report.pdf', '.', '..', '']
  for (const name of bad) {
    const r = local.downloadFile({ id: 'has-downloads', name })
    assert.equal(r.status, 400, `expected 400 for name ${JSON.stringify(name)}`)
    assert.equal(r.ok, false)
  }
})

test('downloadFile() rejects a dotfile (never listed, so never resolvable)', () => {
  const r = local.downloadFile({ id: 'has-downloads', name: '.hidden' })
  assert.equal(r.status, 404, 'a dotfile is skipped by listDownloads, so it never resolves')
  assert.equal(r.ok, false)
})

/* --- knowledge spawn attachments -------------------------------------- *
 * The two halves spawnKnowledge composes, tested off tmux: saveImages() (the
 * write) and knowledgePrompt() (the fold). Driving the whole spawn would need a
 * configured vault AND a live tmux, which the API test job has neither of. */

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('PNG-BYTES').toString('base64')}`

test('a knowledge spawn with attachments writes the files under uploads/<id>', () => {
  const paths = local.saveImages('kb-atlas-q', [
    { name: 'screenshot.png', dataUrl: PNG_DATA_URL },
    { name: 'notes.csv', dataUrl: `data:text/csv;base64,${Buffer.from('a,b\n1,2').toString('base64')}` },
  ])
  assert.equal(paths.length, 2)
  for (const p of paths) {
    assert.ok(
      p.startsWith(path.join(dir, 'uploads', 'kb-atlas-q') + path.sep),
      `${p} must live in the session's upload dir`,
    )
    assert.ok(fs.existsSync(p), `${p} must exist on disk`)
  }
  assert.equal(fs.readFileSync(paths[0], 'utf-8'), 'PNG-BYTES', 'the bytes must survive the data-URL round trip')
  assert.match(paths[0], /screenshot\.png$/, 'the filename (and extension) is preserved so the agent can tell what it is')
  assert.match(paths[1], /notes\.csv$/, 'any file type, not just images')
})

test('saveImages() rejects an unparseable or empty attachment rather than writing junk', () => {
  assert.throws(() => local.saveImages('kb-bad', [{ name: 'x.png', dataUrl: 'not-a-data-url' }]), /invalid or too large/)
  assert.throws(
    () => local.saveImages('kb-bad', [{ name: 'x.png', dataUrl: 'data:image/png;base64,' }]),
    /invalid or too large/,
  )
})

test('the attachment paths reach the opening prompt, with the instruction to Read them', () => {
  const paths = local.saveImages('kb-atlas-fold', [{ name: 'shot.png', dataUrl: PNG_DATA_URL }])
  const prompt = local.knowledgePrompt({
    id: 'kb-atlas-fold',
    question: 'what is wrong in this screenshot?',
    preamble: 'PREAMBLE downloads={downloadsDir}',
    imagePaths: paths,
  })
  assert.match(prompt, /what is wrong in this screenshot\?/)
  assert.ok(prompt.includes(paths[0]), 'the absolute path must be in the prompt — it is how the chat finds the file')
  assert.match(prompt, /Read tool/, 'and it must be told to read it before responding')
  // Single-line tail: a newline in the prompt submits early in the TUI.
  const tail = prompt.slice(prompt.indexOf('[I attached'))
  assert.ok(!tail.includes('\n'), 'the attachment tail must stay on ONE line')
})

test('a knowledge spawn with NO attachments is byte-identical to the pre-attachment prompt', () => {
  const id = 'kb-atlas-plain'
  const dl = path.join(dir, 'downloads', id)
  assert.equal(
    local.knowledgePrompt({ id, question: 'what is X?', preamble: 'PREAMBLE downloads={downloadsDir}' }),
    `PREAMBLE downloads=${dl}\n\n---\n# Operator question\nwhat is X?`,
  )
  // …and with no preamble at all, the bare question (the other original branch).
  assert.equal(local.knowledgePrompt({ id, question: 'what is X?' }), 'what is X?')
})

/* --- wiring guards ----------------------------------------------------- *
 * Source-level, because neither seam has a test double here: agent-routes.mjs
 * imports its executor statically (no DI), and the cards have no DOM harness.
 * Both regressions these pin were SILENT — a dropped attachment, and a chip
 * that navigates the installed PWA away with no way back. */

const src = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf-8')

test('the spawn route forwards attachments to the knowledge executor, still under the shared cap', () => {
  const routes = src('api/src/agent-routes.mjs')
  const capAt = routes.indexOf('too many files (max')
  const branchAt = routes.indexOf("if (kind === 'knowledge')")
  assert.ok(capAt > 0 && branchAt > 0)
  assert.ok(
    capAt < branchAt,
    'the MAX_IMAGES cap + dataUrl validation must run BEFORE the kind branch, so both kinds are capped',
  )
  const call = /local\.spawnKnowledge\(\{[^}]*\}\)/.exec(routes)
  assert.ok(call, 'spawnKnowledge is called')
  assert.match(call[0], /images:\s*imgs/, 'the knowledge branch must pass the validated attachments through, not drop them')
})

test('every agent kind is told where to drop a download', () => {
  const routes = src('api/src/agent-routes.mjs')
  assert.match(routes, /const DOWNLOADS_PREAMBLE\s*=/)
  // knowledge, box-local dev, and workstation dev — three assembly sites.
  const uses = routes.match(/\$\{DOWNLOADS_PREAMBLE\}/g) || []
  assert.ok(uses.length >= 3, `DOWNLOADS_PREAMBLE must reach all three preamble stacks (found ${uses.length})`)
})

test('THE INVARIANT: no tap in the shared chip component can navigate the app away', () => {
  const s = src('web/src/components/AgentDownloads.tsx')
  // ONE hand-off for every presentation — the strip AND the full-screen sheet.
  // The overlay/anchor split IS the mobile rescue, so a second render site
  // adding its own copy is the regression to catch.
  assert.equal(
    (s.match(/<DownloadItem/g) ?? []).length,
    2,
    'the strip and the sheet both render their files through that one component',
  )
  assert.match(s, /downloadRoute\(file, env\)/, 'and it takes the route from the ONE pure decision (lib/downloads.ts)')
  assert.match(s, /plan\.tap === 'overlay' \? \(\s*<button/, 'the in-app item is a button, not an href')

  // ⚠️ THE assertion this file exists for now. The first cut of the rescue left
  // every non-image type on `download` + `target="_blank"`, betting that `_blank`
  // opens a dismissible browser overlay; on a real installed PWA an .html and a
  // .txt each replaced the whole app instead. A new browsing context IS a
  // top-level navigation of the standalone webview, so no `target` may come back.
  // (Comments stripped first — the file EXPLAINS `target="_blank"` at length,
  // which is the point; what must not come back is the attribute itself.)
  const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/target=/.test(code), 'no anchor in this file may open a new browsing context')
  // …and every anchor that survives is a real download, reached only where the
  // attribute is honoured (downloadRoute: `downloadHonoured && !standalone`).
  for (const m of code.matchAll(/<a\b/g)) {
    assert.match(
      code.slice(m.index, m.index + 400),
      /download=/,
      `a bare navigating <a> at index ${m.index} — every anchor here must carry \`download\``,
    )
  }

  // The HTML preview renders agent-authored (i.e. untrusted) markup. Scripts may
  // run; reaching the dashboard's own origin and storage may not, and the absent
  // allow-top-navigation is what keeps the invariant above structural.
  assert.match(code, /sandbox="allow-scripts"/, 'the HTML preview is sandboxed')
  assert.ok(!code.includes('allow-same-origin'), 'NEVER together with allow-same-origin')
  assert.ok(!code.includes('allow-top-navigation') && !code.includes('allow-popups'))

  // The save route: the share sheet needs the tap's transient activation, so the
  // blob is prefetched when the overlay OPENS and the handler calls share() with
  // no await in front of it.
  assert.match(s, /navigator\s*\.share\(\{ files: \[shareFile\] \}\)/, 'share() takes an already-fetched File')
  assert.match(s, /name === 'AbortError'\) return/, 'a dismissed share sheet is normal, never an error')
})

test('the preview overlay AND the sheet close on all FOUR routes, on ONE history entry', () => {
  const s = src('web/src/components/AgentDownloads.tsx')
  assert.match(s, /history\.pushState/, '1+4: an entry so the phone back gesture closes the overlay instead of leaving the app')
  assert.match(s, /addEventListener\('popstate'/)
  assert.match(s, /if \(!popped\) history\.back\(\)/, 'closing another way must pop the entry so the stack cannot accumulate')
  // ONE entry for the whole stack (the sheet can carry the preview on top), and
  // the pop dismisses both — two entries cannot be made safe when both handlers
  // sit on `window`. So the push is gated on `open`, not on `preview` alone.
  assert.match(s, /const open = sheetOpen \|\| !!preview/, 'one entry covers sheet + preview')
  assert.match(s, /e\.key !== 'Escape'\) return/, 'Escape (desktop)')
  assert.match(
    s,
    /addEventListener\('keydown', onKey, true\)/,
    'in the CAPTURE phase — the full-screen viewer closes itself on Escape from a bubble listener registered first, so this would otherwise tear the whole viewer down',
  )
  assert.match(s, /className="dlprev" onClick=\{\(\) => setPreview\(null\)\}/, 'backdrop tap (preview)')
  assert.match(s, /className="dlsheet-backdrop" onClick=/, 'backdrop tap (sheet)')
  assert.match(s, /aria-label="close preview"/, 'the ✕ control (preview)')
  assert.match(s, /className="dlsheet__close"/, 'the ✕ control (sheet)')
  // …and an explicit Save, whichever route this browser has: the share sheet
  // where it exists, the plain download where `download` is honoured.
  assert.match(s, /plan\.save === 'share' \? \(/, 'the share-sheet Save')
  assert.match(s, /href=\{url\} download=\{file\.name\}/, 'the real-download Save')
})

test('the sheet flag is reset with the files — a NEW download must not re-open it unprompted', () => {
  const s = src('web/src/components/AgentDownloads.tsx')
  // `sheetOpen` is derived (`compact && sheet && files.length > 0`), so an agent
  // whose last file vanishes correctly unmounts the sheet and unwinds its history
  // entry — but the `sheet` flag it was opened with would survive, and the next
  // file the agent drops flips it back on its own: a bottom sheet appearing over
  // the transcript on the phone with nobody having tapped anything.
  assert.match(
    s,
    /useEffect\(\(\) => \{\s*if \(!files\.length\) setSheet\(false\)\s*\}, \[files\.length\]\)/,
    'clear `sheet` when it can no longer be open, rather than stranding it',
  )
})
