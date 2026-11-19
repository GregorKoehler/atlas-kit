/* ------------------------------------------------------------------ *
 * A page's markdown sections, as the semantic chunker cuts them.
 *
 * Lives in core, not in the semantic-search addon, because two readers must cut
 * a page the SAME way: the addon's chunker (each chunk's `crumb` is the `section`
 * a semantic query_vault row prints) and get_note (api/src/note-answer.mjs), which
 * takes that `section` back as it stands. One function, so the two cannot drift.
 * ------------------------------------------------------------------ */

export function stripFrontmatter(md) {
  if (md.startsWith('---')) {
    const end = md.indexOf('\n---', 3)
    if (end !== -1) {
      const after = md.indexOf('\n', end + 1)
      return after !== -1 ? md.slice(after + 1) : ''
    }
  }
  return md
}

/**
 * Split one page's body into sections at ATX headings, as CHAR RANGES into
 * `body` plus the heading breadcrumb. A heading with no body under it is
 * dropped (a bare `## Notes` carries no retrievable claim), but its text
 * survives in its children's breadcrumb — and, once the chunker merges ranges,
 * in the merged range itself.
 *
 * → [{ crumb, start, end }] with `body.slice(start, end)` already trimmed at
 *   both edges, in document order, non-overlapping.
 */
export function sections(body) {
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
