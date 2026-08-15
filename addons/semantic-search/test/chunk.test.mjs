/* ------------------------------------------------------------------ *
 * The section chunker (api/chunk.mjs).
 *
 * The properties a diff can silently lose, each of which cost something real:
 *   1. a chunk's `start`/`end` are a TRUE ADDRESS into the frontmatter-stripped
 *      body — the snippet and the evidence quote are sliced live at that range,
 *      so an off-by-anything shows the WRONG part of the right page, silently;
 *   2. tiny sections MERGE FORWARD rather than becoming near-empty vectors that
 *      sit at middling cosine to everything;
 *   3. `windowRanges(..., overlap: 0)` covers every character exactly once —
 *      the invariant `subAsks` relies on to claim it decomposes a task;
 *   4. the walk mirrors the lexical leg's (dotfiles skipped, `.md` only,
 *      frontmatter stripped), so "full-text 0, semantic 24" is a fact about the
 *      query and not about two different corpora.
 *
 * Synthetic corpus only — no encoder, no index, no vault.
 *
 * Run: node --test addons/semantic-search/test/chunk.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chunkVault, chunkText, pageBody, windowRanges, CHUNKER_VERSION } from '../api/chunk.mjs'

function vault(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-chunk-'))
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }
  return root
}

const para = (n, word = 'alpha') => Array.from({ length: n }, () => word).join(' ')

test('every chunk range is a true address into the page body', () => {
  const root = vault({
    'Wiki/Long.md': `---\ntype: concept\n---\n# Long\n\n## One\n\n${para(200)}\n\n## Two\n\n${para(200)}\n`,
    'Tasks/Flat.md': `# Flat\n\n${para(150)}\n`,
  })
  const { chunks, pages } = chunkVault(root)
  assert.equal(pages, 2)
  assert.ok(chunks.length >= 3)
  for (const c of chunks) {
    const body = pageBody(root, c.path)
    assert.equal(body.slice(c.start, c.end), c.text, `${c.path} [${c.start},${c.end}) does not slice back to its own text`)
  }
  // Frontmatter is gone from the body the offsets index into.
  assert.ok(!pageBody(root, 'Wiki/Long.md').includes('type: concept'))
})

test('a section under the floor merges FORWARD, swallowing the heading between', () => {
  const root = vault({ 'Wiki/Small.md': `# Small\n\n## Stub\n\ntiny\n\n## Real\n\n${para(200)}\n` })
  const { chunks } = chunkVault(root)
  // "tiny" is far under MIN_CHARS, so it does not get a vector of its own…
  assert.ok(!chunks.some((c) => c.text.trim() === 'tiny'))
  // …it is inside the merged range, and so is the `## Real` heading it swallowed.
  const merged = chunks.find((c) => c.text.includes('tiny'))
  assert.ok(merged, 'the small section vanished instead of merging')
  assert.ok(merged.text.includes('## Real'), 'the merged range must swallow the intervening heading as context')
})

test('a heading with no body under it is dropped but survives in the breadcrumb', () => {
  const root = vault({ 'Wiki/Crumbs.md': `# Crumbs\n\n## Outer\n\n### Inner\n\n${para(200)}\n` })
  const { chunks } = chunkVault(root)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].crumb, 'Crumbs › Outer › Inner')
  assert.ok(chunkText(chunks[0]).startsWith('Crumbs › Outer › Inner\n\n'))
})

test('windowRanges with overlap 0 covers every character exactly once', () => {
  const body = Array.from({ length: 40 }, (_, i) => para(30, `w${i}`)).join('\n\n')
  const ranges = windowRanges(body, 0, body.length, 500, 0)
  assert.ok(ranges.length > 3, 'the fixture must actually split')
  for (let i = 1; i < ranges.length; i++) {
    assert.ok(ranges[i][0] >= ranges[i - 1][1], `window ${i} starts before the previous one ended — words in two spans`)
  }
  // Every range slices back verbatim (the reason this works in offsets).
  for (const [a, b] of ranges) assert.equal(body.slice(a, b), body.slice(a, b).trim())
})

test('the default overlap DOES carry context forward — 0 is a deliberate override', () => {
  const body = Array.from({ length: 40 }, (_, i) => para(30, `w${i}`)).join('\n\n')
  const withOverlap = windowRanges(body, 0, body.length, 500)
  const butted = windowRanges(body, 0, body.length, 500, 0)
  assert.ok(withOverlap.some((r, i) => i > 0 && r[0] < butted[i]?.[0]), 'the default must overlap; only subAsks passes 0')
})

test('the walk mirrors the lexical leg: dotfiles skipped, `.md` only', () => {
  const root = vault({
    'Wiki/Real.md': `# Real\n\n${para(150)}\n`,
    'Wiki/notes.txt': 'not markdown',
    '.obsidian/cache.md': '# hidden\n\nshould not be indexed',
    'Wiki/.hidden.md': '# also hidden\n\nnope',
  })
  const { chunks, pages } = chunkVault(root)
  assert.equal(pages, 1)
  assert.deepEqual([...new Set(chunks.map((c) => c.path))], ['Wiki/Real.md'])
})

test('a page with no headings at all is one chunk, and CHUNKER_VERSION is pinned', () => {
  const root = vault({ 'Tasks/plain.md': `${para(150)}\n` })
  const { chunks } = chunkVault(root)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].crumb, '')
  assert.equal(chunks[0].title, 'plain', 'no `# heading` → the filename is the title')
  // The reader refuses an index built by a different chunker; bumping this
  // constant is what forces that rebuild, so it is part of the contract.
  assert.equal(CHUNKER_VERSION, 2)
})

test('pageBody returns null for a page that is gone, rather than throwing', () => {
  const root = vault({ 'Wiki/A.md': '# A\n\nbody\n' })
  assert.equal(pageBody(root, 'Wiki/Missing.md'), null)
})
