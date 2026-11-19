/* ------------------------------------------------------------------ *
 * get_note: every part of a long page is reachable.
 *
 * Capping get_note at the head left everything past 20,000 chars unreadable, and
 * logs append at the BOTTOM: on a long log page the newest history could not be
 * read at all. So:
 *   · over the cap → the head, the exact next call, and an outline of what was cut;
 *   · `section` → one `##`/`###` section verbatim;
 *   · `offset` → a continuation, chars into the section (or the page without one).
 * Every answer stays ≤ max, and each truncation note names the exact next call.
 *
 * The outline gets at most 15% of the cap. Measured on a ~1,600-page Atlas (72
 * pages over the cap): 70 outlines need ≤ 1,300 chars, so they fit whole and the
 * head keeps what they leave; only the two biggest log pages overflow it, and
 * those keep both ends, since logs append and the newest section is the last one.
 * However many sections a page has, the outline can't starve the head.
 *
 * Tests: api/test/get-note-reach.test.mjs.
 * ------------------------------------------------------------------ */
import { sections as chunkSections, stripFrontmatter } from './md-sections.mjs'

const RESPONSE_MAX = 20000 // the MCP read tools' cap (api/src/mcp/tools.mjs)
const OUTLINE_SHARE = 0.15

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const HEADING = /^(#{1,3})[ \t]+(.*\S)\s*$/
const sectionKey = (v) => String(v ?? '').trim().replace(/^#{1,6}[ \t]+/, '').trim().toLowerCase()

// The page's real headings, level 1-3, as char ranges into `md`. Skips the
// frontmatter and fenced code (the Atlas Guide has a `## Log` inside a ```markdown
// fence). `##`/`###` get a unique `value` — the string that fetches them: the
// heading itself, or "<heading> #2" for a repeat. A `#` only ends a section.
function noteHeadings(md) {
  const fm = md.length - stripFrontmatter(md).length
  const out = []
  let fence = null
  let at = fm
  for (const line of md.slice(fm).split('\n')) {
    const f = line.match(FENCE)
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null
    } else if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = f[1]
    } else {
      const h = line.match(HEADING)
      if (h) out.push({ level: h[1].length, heading: h[2], start: at })
    }
    at += line.length + 1
  }
  out.forEach((h, i) => {
    let j = i + 1
    while (j < out.length && out[j].level > h.level) j++
    h.end = out[j]?.start ?? md.length
  })
  const named = out.filter((h) => h.level > 1)
  const used = new Set()
  const first = new Map()
  const repeats = []
  for (const h of named) {
    const key = sectionKey(h.heading)
    if (used.has(key)) repeats.push(h)
    else {
      used.add(key)
      first.set(key, h)
      h.value = h.heading
    }
  }
  // Second pass, so a literal "## Log #2" keeps its own name.
  for (const h of repeats) {
    let k = 2
    while (used.has(sectionKey(`${h.heading} #${k}`))) k++
    h.value = `${h.heading} #${k}`
    used.add(sectionKey(h.value))
    const key = sectionKey(h.heading)
    first.get(key).twin = h.value // each one names the next, so a repeat can't go unnoticed
    first.set(key, h)
  }
  return out
}

// What `asked` fetches: an exact section value, or a query_vault semantic row's
// `section` — the chunker's breadcrumb ("Title › Part › Sub"). A breadcrumb is
// resolved through the chunker itself, so the two can't drift: it may name a
// `####`, a heading inside a fence, or the text before any `##`, none of which is
// a section here, and it lands on whatever real section holds that text.
function findSection(md, headings, asked) {
  const key = sectionKey(asked)
  const direct = headings.find((h) => h.value && sectionKey(h.value) === key)
  if (direct) return direct
  const body = stripFrontmatter(md)
  const hit = chunkSections(body).find((c) => sectionKey(c.crumb) === key)
  if (!hit) return null
  const fm = md.length - body.length
  const pos = fm + hit.start
  const holder = headings.findLast((h) => h.start <= pos)
  if (holder?.value) return holder
  const start = holder ? holder.start : fm
  return { value: asked, start, end: headings.find((h) => h.start > start)?.start ?? md.length }
}

// The end of one part starting at `from`: a line boundary (the newline stays with
// this part, so the parts concatenate back exactly), unless no line ends nearby.
function partEnd(s, from, room) {
  let to = from + room
  const nl = s.lastIndexOf('\n', to - 1)
  if (nl >= from + room / 2) return nl + 1
  const c = s.charCodeAt(to - 1)
  if (c >= 0xd800 && c <= 0xdbff) to-- // never split a surrogate pair
  return to
}

// Bounded list of sections: whole if it fits, else both ends and a line saying
// how many were left out and where to read them.
function outlineOf(list, { title, cut, budget, gapCall }) {
  const head = `${title}: ${list.length}, as size in chars + \`section\` value:`
  const lines = list.map((x) => `- ${x.end - x.start}: ${JSON.stringify(x.value)}${x.start < cut ? ' (the cut falls in this one)' : ''}`)
  const whole = [head, ...lines].join('\n')
  if (whole.length <= budget) return whole
  const gap = (n, from) => `… ${n} more not listed: they start at char ${from} — ${gapCall(from)}`
  const room = (budget - head.length - gap(list.length, list.at(-1).end).length - 2) / 2
  let a = 0
  for (let used = 0; a < lines.length && used + lines[a].length + 1 <= room; a++) used += lines[a].length + 1
  let b = lines.length
  for (let used = 0; b > a && used + lines[b - 1].length + 1 <= room; b--) used += lines[b - 1].length + 1
  return [head, ...lines.slice(0, a), gap(b - a, list[a].start), ...lines.slice(b)].join('\n')
}

/* One get_note answer, from the full page text.
 *
 * Pure, so the bounds and the byte-exact continuations are testable without the
 * API. Throws on an unknown section or an offset past the end; tools.mjs's tool()
 * turns that into a readable tool error. */
export function noteAnswer(md, { path = '', vault, section, offset = 0, max = RESPONSE_MAX } = {}) {
  const s = typeof md === 'string' ? md : String(md ?? '')
  const asked = String(section ?? '').trim()
  if (!asked && !offset && s.length <= max) return s

  const headings = noteHeadings(s)
  const call = (args) => `get_note ${JSON.stringify({ path, ...(vault ? { vault } : {}), ...args })}`
  const budget = Math.floor(max * OUTLINE_SHARE)
  const sec = asked ? findSection(s, headings, asked) : null
  if (asked && !sec) {
    const all = headings.filter((h) => h.value)
    throw new Error(
      `no section ${JSON.stringify(asked)} in ${path}. ` +
        (all.length
          ? outlineOf(all, { title: 'Sections on this page', cut: 0, budget, gapCall: (from) => call({ offset: from }) })
          : `This page has no ## or ### sections: read it with ${call({})}`),
    )
  }

  const base = sec ? sec.start : 0
  const end = sec ? sec.end : s.length
  const len = end - base
  if (offset && offset >= len) throw new Error(`offset ${offset} is past the end of ${sec ? `section ${JSON.stringify(sec.value)}` : 'the page'}: it has ${len} chars`)
  const from = base + offset
  const where = sec ? { section: sec.value } : {}
  const isHead = !sec && !offset
  const twin = sec?.twin ? `; another section has this heading: ${JSON.stringify(sec.twin)}` : ''
  const label = (to) => {
    if (isHead) return ''
    const page = `chars ${from}–${to} of ${s.length}`
    return sec
      ? `[${path} § ${JSON.stringify(sec.value)}: ${page}; section chars ${offset}–${to - base} of ${len}${twin}]\n`
      : `[${path}: ${page}]\n`
  }
  if (label(end).length + end - from <= max) return label(end) + s.slice(from, end)

  const note = (to, listed) =>
    isHead
      ? `\n… [truncated: ${to} of ${s.length} chars — this page is long. Next call: ${call({ offset: to })}. To jump instead: ${listed ? 'a section below, or ' : ''}query_vault (prose) / query_atlas (typed).]`
      : `\n… [${end - to} more chars — next call: ${call({ ...where, offset: to - base })}${listed ? ', or one subsection below' : ''}]`
  const list = isHead ? headings.filter((h) => h.level === 2) : sec?.level === 2 && !offset ? headings.filter((h) => h.level === 3 && h.start >= base && h.end <= end) : []
  const outline = (cut) => {
    const cutOff = list.filter((x) => x.end > cut)
    if (!cutOff.length) return ''
    const opts = isHead
      ? { title: `Sections past the cut (fetch one: ${call({ section: '<value>' })})`, gapCall: (at) => call({ offset: at }) }
      : { title: `Subsections past the cut (fetch one: ${call({ section: '<value>' })})`, gapCall: (at) => call({ ...where, offset: at - base }) }
    return `\n\n${outlineOf(cutOff, { ...opts, cut, budget })}`
  }
  // The outline's size depends on the cut and the cut on the outline's size, so
  // grow the reservation until the outline fits it. The reservation only rises
  // and the outline is bounded by `budget`, so this stops within a few rounds.
  // Sized at the widest they can print: note(end) says "0 more chars", where the
  // real note can carry every digit of `len`.
  const room = max - label(end).length - note(end, true).length - String(len).length
  let reserve = 0
  let cut
  let tail
  for (;;) {
    cut = partEnd(s, from, room - reserve)
    tail = outline(cut)
    if (tail.length <= reserve) break
    reserve = tail.length
  }
  return label(cut) + s.slice(from, cut) + note(cut, !!tail) + tail
}

