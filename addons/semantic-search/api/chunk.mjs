/* ------------------------------------------------------------------ *
 * Section chunker for the SEMANTIC leg — vault → embeddable chunks.
 *
 * WHY SECTIONS AND NOT PAGES. One vector per page fails on a real Atlas for the
 * same reason BM25F needs length normalisation: a mature project page is a book,
 * and a single 768-float summary of a book answers every query mediocrely and
 * none well. Markdown headings are the natural boundary and an Atlas is heavily
 * sectioned, so they are also a free one.
 *
 * The file walk deliberately MIRRORS `read-routes.mjs`'s `listMdRecursive` +
 * `stripFrontmatter` (dotfiles skipped, `.md` only, whole vault root, YAML
 * frontmatter stripped) so the lexical and semantic legs see the SAME corpus —
 * which is what makes "full-text: 0 hits, semantic: 24" an honest signal about
 * the query rather than about two different indexes.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'

/* Bump when the chunk boundaries change. It is recorded in the index's
 * meta.json and a mismatch forces a full re-embed — a vector produced from
 * different text than the reader thinks is worse than no vector. */
export const CHUNKER_VERSION = 2

// Approximate, and only ever used to DECIDE A SPLIT — never reported as a token
// count. ~4 chars/token is the usual English figure; German compounds run
// denser, which is why the cap below sits well under the model's 2048 limit.
const CHARS_PER_TOKEN = 4
const TARGET_TOKENS = 512 // split a section longer than this
const OVERLAP_CHARS = 200 // carry-over between hard-split windows

/* A FLOOR AS WELL AS A CEILING, and the floor is the one that is easy to miss.
 * Measured over a live 1.6k-page Atlas: 18.2% of 11,573 chunks came in under
 * 100 tokens and 176 under 30 — and the smallest were not short facts but
 * DEBRIS: a bare `---` rule, a one-line capture stamp, an empty stub under a
 * heading. A near-empty vector is not harmless; it is promiscuous, sitting at
 * middling cosine to everything and displacing real answers in a top-24. So a
 * section below the floor is merged FORWARD into what follows (the last one
 * merges backward, since there is nothing after it).
 *
 * ⚠️ A merged chunk is defined as `body.slice(start, end)`, i.e. the range
 * SWALLOWS the intervening heading lines rather than re-joining two texts. That
 * keeps the heading as context where it belongs and keeps `start`/`end` a true
 * address into the page — which is what the semantic snippet slices.
 *
 * The ceiling was already doing its job: with sections split at every ATX
 * heading and `windowRanges()` below, the measured max was 604 tokens, not the
 * runaway `## Log` the floor was written to worry about — an Atlas log's entries
 * are `## [date] …` HEADINGS, so they were already one chunk per entry. */
const MIN_CHARS = 400 // ≈100 tokens

function listMdRecursive(absDir, out = []) {
  let entries = []
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const abs = path.join(absDir, e.name)
    if (e.isDirectory()) listMdRecursive(abs, out)
    else if (e.name.toLowerCase().endsWith('.md')) out.push(abs)
  }
  return out
}

function stripFrontmatter(md) {
  if (md.startsWith('---')) {
    const end = md.indexOf('\n---', 3)
    if (end !== -1) {
      const after = md.indexOf('\n', end + 1)
      return after !== -1 ? md.slice(after + 1) : ''
    }
  }
  return md
}

function firstHeading(md, fallback) {
  for (const line of stripFrontmatter(md).split('\n')) {
    const m = line.match(/^#\s+(.+)$/)
    if (m) return m[1].trim()
  }
  return fallback
}

/**
 * Split one page's body into sections at ATX headings, as CHAR RANGES into
 * `body` plus the heading breadcrumb. A heading with no body under it is
 * dropped (a bare `## Notes` carries no retrievable claim), but its text
 * survives in its children's breadcrumb — and, once ranges are merged below,
 * in the merged range itself.
 *
 * → [{ crumb, start, end }] with `body.slice(start, end)` already trimmed at
 *   both edges, in document order, non-overlapping.
 */
function sections(body) {
  const lines = body.split('\n')
  const out = []
  const stack = [] // [{ depth, text }]
  let bufStart = 0
  let bufEnd = 0
  let hasBuf = false
  let offset = 0
  const flush = () => {
    if (hasBuf) {
      const raw = body.slice(bufStart, bufEnd)
      const lead = raw.length - raw.trimStart().length
      const text = raw.trim()
      if (text) out.push({ crumb: stack.map((s) => s.text).join(' › '), start: bufStart + lead, end: bufStart + lead + text.length })
    }
    hasBuf = false
  }
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+)$/)
    if (m) {
      flush()
      const depth = m[1].length
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop()
      stack.push({ depth, text: m[2].trim() })
    } else {
      if (!hasBuf) (bufStart = offset), (hasBuf = true)
      bufEnd = offset + line.length
    }
    offset += line.length + 1
  }
  flush()
  return out
}

/**
 * Merge sections under the floor into their neighbour, by EXTENDING RANGES —
 * so the merged chunk is still one contiguous slice of the page and the
 * intervening headings come along as context. See MIN_CHARS above for why.
 *
 * Deterministic by construction (a pure left-to-right fold over the ranges),
 * which is what makes a rewrite safe: the same page always yields the same
 * boundaries, so an untouched section always hashes to a cache hit.
 */
function mergeSmall(secs) {
  const out = []
  for (const s of secs) {
    const prev = out[out.length - 1]
    // A run stays open until it clears the floor; the next section extends it.
    if (prev && prev.end - prev.start < MIN_CHARS) prev.end = s.end
    else out.push({ ...s })
  }
  // The LAST run can still be under the floor (nothing follows to absorb it):
  // fold it backwards instead, unless it is the only one on the page.
  if (out.length > 1 && out[out.length - 1].end - out[out.length - 1].start < MIN_CHARS) {
    const tail = out.pop()
    out[out.length - 1].end = tail.end
  }
  return out
}

/**
 * Hard-split an over-long section on paragraph boundaries, with overlap.
 *
 * ⚠️ WORKS IN OFFSETS, NOT STRINGS, and that is load-bearing rather than
 * stylistic. Re-joining paragraphs with `'\n\n'` produces text that may not
 * appear verbatim in the page (the real separator can be `'\n   \n'`), so the
 * chunk could no longer be located in the page it came from — measured: 16 of
 * 9,628 chunks. `meta.json` stores char ranges instead of thousands of chunk
 * bodies and the semantic snippet is sliced live out of the page at that range,
 * so an unlocatable chunk shows the WRONG part of the right page, silently.
 * Slicing the body directly makes every range exact by construction.
 *
 * `overlap` is the carry-over between windows. It defaults to `OVERLAP_CHARS` —
 * a document chunk wants its neighbour's tail as context — and is a parameter
 * because `subAsks` (evidence.mjs) reuses this to split an over-long ASK and
 * must pass 0: its stated invariant is that every word of the task is covered by
 * EXACTLY ONE span, which an overlap would break.
 *
 * → [[start, end], …] absolute in `body`, each already trimmed at both edges,
 *   non-overlapping when `overlap` is 0.
 */
export function windowRanges(body, start, end, maxChars, overlap = OVERLAP_CHARS) {
  if (end - start <= maxChars) return [[start, end]]
  const out = []
  const push = (s, e) => {
    const raw = body.slice(s, e)
    const lead = raw.length - raw.trimStart().length
    const text = raw.trim()
    if (text) out.push([s + lead, s + lead + text.length])
  }
  // Paragraph boundaries as absolute ranges.
  const text = body.slice(start, end)
  const paras = []
  const re = /\n\s*\n/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    paras.push([start + last, start + m.index])
    last = m.index + m[0].length
  }
  paras.push([start + last, end])

  let curS = null
  let curE = null
  for (const [ps, pe] of paras) {
    // A single paragraph longer than the window (a big table, a log block) is
    // sliced blind — rare, and better than dropping it.
    if (pe - ps > maxChars) {
      if (curS !== null) (push(curS, curE), (curS = null))
      for (let i = ps; i < pe; i += maxChars - overlap) push(i, Math.min(pe, i + maxChars))
      continue
    }
    if (curS !== null && pe - curS > maxChars) {
      push(curS, curE)
      curS = Math.max(curS, curE - overlap) // carry the overlap forward (0 ⇒ butt-joined, no word in two spans)
    }
    if (curS === null) curS = ps
    curE = pe
  }
  if (curS !== null) push(curS, curE)
  return out
}

/**
 * Every chunk in the vault at `root`.
 * → { chunks: [{ id, path, title, crumb, text, start, end }], pages }
 *   `path` is vault-relative; `start`/`end` are character offsets into the
 *   FRONTMATTER-STRIPPED body, so a caller can slice a snippet out of the live
 *   page instead of this module carrying every chunk body around in meta.json.
 */
export function chunkVault(root) {
  const maxChars = TARGET_TOKENS * CHARS_PER_TOKEN
  const chunks = []
  let pages = 0
  for (const abs of listMdRecursive(root)) {
    let md
    try {
      md = fs.readFileSync(abs, 'utf-8')
    } catch {
      continue
    }
    const rel = path.relative(root, abs)
    const title = firstHeading(md, path.basename(abs, '.md'))
    const body = stripFrontmatter(md)
    pages++
    const secs = mergeSmall(sections(body))
    // A page with no headings at all (most Tasks/ notes) is one section.
    const trimmed = body.trim()
    const list = secs.length ? secs : trimmed ? [{ crumb: '', start: body.indexOf(trimmed), end: body.indexOf(trimmed) + trimmed.length }] : []
    for (const s of list) {
      for (const [start, end] of windowRanges(body, s.start, s.end, maxChars)) {
        chunks.push({ id: chunks.length, path: rel, title, crumb: s.crumb, text: body.slice(start, end), start, end })
      }
    }
  }
  return { chunks, pages }
}

/** The document-side text handed to the model, before the task prompt. */
export function chunkText(c) {
  return c.crumb ? `${c.crumb}\n\n${c.text}` : c.text
}

/** Read a page's frontmatter-stripped body — the thing `start`/`end` index into. */
export function pageBody(root, rel) {
  try {
    return stripFrontmatter(fs.readFileSync(path.join(root, rel), 'utf-8'))
  } catch {
    return null
  }
}
