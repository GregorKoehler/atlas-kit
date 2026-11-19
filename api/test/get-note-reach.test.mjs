/* ------------------------------------------------------------------ *
 * get_note must reach EVERY part of a long Atlas page.
 *
 * The defect: a page over 20,000 chars came back as its head plus a truncation
 * note and nothing past the cut could be read, by any call. Logs append at the
 * bottom, so the part that got cut was the newest history — and a mature vault's
 * log pages run far over the cap (~1 MB, or one ~470 KB `## Log`).
 *
 * Pinned here: pages under the cap byte-identical; every answer ≤ the cap, outline
 * included; every cut section listed with the value that fetches it; repeated
 * headings addressable; fenced headings ignored; a query_vault `section` accepted
 * as it stands; and continuations that concatenate back byte for byte.
 *
 * Run: node --test api/test/get-note-reach.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CAP = 20000
const P = 'Wiki/Long.md'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-get-note-'))
process.env.VAULTS_FILE = path.join(DIR, 'vaults.json')
fs.writeFileSync(process.env.VAULTS_FILE, JSON.stringify({ atlas: { path: '/vault-atlas', label: 'Atlas', default: true }, plain: { path: '/vault', label: 'Plain' } }))

let served = ''
const api = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(served)
})
await new Promise((r) => api.listen(0, '127.0.0.1', r))
process.env.ATLAS_API_BASE = `http://127.0.0.1:${api.address().port}`
test.after(() => api.close())

const { noteAnswer } = await import('../src/note-answer.mjs')
const { buildServer } = await import('../src/mcp/tools.mjs')
const { sections: chunkSections, stripFrontmatter } = await import('../src/md-sections.mjs')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

const server = buildServer({ knowledgeOnly: true })
const [clientT, serverT] = InMemoryTransport.createLinkedPair()
const client = new Client({ name: 'get-note-test', version: '0' })
await Promise.all([server.connect(serverT), client.connect(clientT)])
test.after(() => client.close())

/* --- fixtures ---------------------------------------------------------- */
const prose = (chars, tag = 'line') => {
  const out = []
  for (let n = 0, i = 0; n < chars; i++) {
    const l = `${tag} ${i} ${'word '.repeat(12)}\n`
    out.push(l)
    n += l.length
  }
  return out.join('')
}
const FM = '---\ntype: concept\n# not a heading: a YAML comment\ntitle: Long\n---\n'
const longPage = () =>
  `${FM}# Long\n\nIntro.\n\n## Early\n${prose(16000, 'early')}\n## Crossing\n${prose(9000, 'cross')}\n### Crossing sub\n${prose(500, 'sub')}\n` +
  `## Log\nfirst log\n\n## Middle\n${prose(3000, 'mid')}\n\`\`\`markdown\n## Fenced heading\n\`\`\`\n~~~\n### Fenced too\n~~~\n## Log\nsecond log\n`

/* --- parsers: what an agent does with an answer --------------------------- */
const POSITION = /chars (\d+)–(\d+) of (\d+)(?:; section chars (\d+)–(\d+) of (\d+)(?:; another section has this heading: .*)?)?\]$/
// A part's verbatim text, its position, and the next call its note names.
function part(answer) {
  const first = answer.slice(0, answer.indexOf('\n'))
  const m = first.match(POSITION)
  assert.ok(m, `no position line: ${first}`)
  const [a, b, c, d] = [m[1], m[2], m[4], m[5]].map(Number)
  const size = m[4] === undefined ? b - a : d - c
  const body = answer.slice(first.length + 1, first.length + 1 + size)
  const rest = answer.slice(first.length + 1 + size)
  const next = rest.match(/next call: get_note (\{.*?\})(?:, or one subsection below)?\]/)
  return { first, a, b, c, d, body, rest, next: next ? JSON.parse(next[1]) : null }
}
function headOf(answer) {
  const at = answer.lastIndexOf('\n… [truncated: ')
  assert.ok(at >= 0, 'no truncation note')
  const note = answer.slice(at)
  const m = note.match(/truncated: (\d+) of (\d+) chars — this page is long\. Next call: get_note (\{.*?\})\./)
  assert.ok(m, note.slice(0, 200))
  assert.equal(answer.slice(0, at).length, Number(m[1]), 'the head is exactly as long as its note says')
  const listed = [...note.matchAll(/^- (\d+): (".*?")( \(the cut falls in this one\))?$/gm)].map((x) => ({ size: Number(x[1]), value: JSON.parse(x[2]), cutHere: !!x[3] }))
  const gap = note.match(/^… (\d+) more not listed: they start at char (\d+) — get_note (\{.*\})$/m)
  return { head: answer.slice(0, at), cut: Number(m[1]), next: JSON.parse(m[3]), listed, gap: gap && { n: Number(gap[1]), from: Number(gap[2]), next: JSON.parse(gap[3]) }, note }
}
// Follow the continuations of a section or a page, asserting the cap throughout.
function walk(md, args, max = CAP) {
  let out = ''
  let calls = 0
  for (let a = args; a; calls++) {
    const answer = noteAnswer(md, { path: P, ...a, max })
    assert.ok(answer.length <= max, `answer of ${answer.length} chars for ${JSON.stringify(a)}`)
    const p = part(answer)
    out += p.body
    a = p.next
  }
  return { text: out, calls }
}

/* --- 1. under the cap --------------------------------------------------- */
test('a page at or under the cap is byte-identical, frontmatter and all', () => {
  for (const md of ['# Short\n\nnotes\n', '', `${FM}## A\nb\n`, 'x'.repeat(CAP)]) assert.equal(noteAnswer(md, { path: P }), md)
  assert.equal(noteAnswer('# Short', { path: P, section: '  ', offset: 0 }), '# Short', 'a blank section (a heading-less semantic row) is no section')
})

/* --- 2. the head and its outline ----------------------------------------- */
test('over the cap: the head keeps the frontmatter, and the outline lists every cut section with its fetch value', () => {
  const md = longPage()
  const answer = noteAnswer(md, { path: P })
  assert.ok(answer.length <= CAP, `${answer.length}`)
  const h = headOf(answer)
  assert.ok(h.head.startsWith(FM), 'the head keeps the frontmatter')
  assert.equal(h.head, md.slice(0, h.cut), 'the head is verbatim')
  assert.equal(md[h.cut - 1], '\n', 'cut at a line boundary')
  assert.deepEqual(h.next, { path: P, offset: h.cut })
  assert.deepEqual(h.listed.map((x) => x.value), ['Crossing', 'Log', 'Middle', 'Log #2'], '`## Early` is whole in the head; `###` and fenced headings are not listed')
  assert.equal(h.listed[0].cutHere, true, 'the section the cut falls in is marked')
  assert.ok(!h.listed.slice(1).some((x) => x.cutHere))
  for (const x of h.listed) {
    assert.equal(walk(md, { section: x.value }).text.length, x.size, `${x.value}: the printed size is the fetched size`)
  }
  assert.doesNotMatch(answer.slice(h.cut), /Fenced/)
})

test('a section that starts exactly at the cut is not reported as cut through', () => {
  // Head room is a whole number of short lines, so try the boundary at several sizes.
  for (let n = 15000; n < 20000; n += 37) {
    const md = `# T\n${prose(n)}## Next\n${prose(6000)}`
    const h = headOf(noteAnswer(md, { path: P }))
    const next = md.indexOf('## Next')
    assert.equal(h.listed.find((x) => x.value === 'Next').cutHere, h.cut > next)
  }
})

test('an archive with hundreds of sections keeps a bounded, self-describing outline and most of its head', () => {
  const md = `# Archive\n\n${Array.from({ length: 400 }, (_, i) => `## [2026-07-${i}] entry ${i} ${'title '.repeat(10)}\n${prose(500, `e${i}`)}`).join('\n')}`
  const answer = noteAnswer(md, { path: P })
  assert.ok(answer.length <= CAP)
  const h = headOf(answer)
  assert.ok(h.cut > CAP * 0.75, `the outline starved the head: ${h.cut}`)
  assert.ok(h.note.length <= CAP * 0.2, `outline + note ${h.note.length}`)
  assert.ok(h.gap, 'says what it left out')
  const cutCount = md.slice(h.cut).split('\n## ').length // sections after the cut, plus the one it falls in
  assert.equal(h.listed.length + h.gap.n, cutCount, 'listed + "N more" accounts for every cut section')
  assert.match(h.listed.at(-1).value, /entry 399/, 'logs append: the NEWEST section stays listed')
  assert.ok(h.listed.some((x) => /entry 3\d\d/.test(x.value)))
  assert.deepEqual(h.gap.next, { path: P, offset: h.gap.from })
  const omitted = noteAnswer(md, { path: P, ...h.gap.next })
  assert.ok(part(omitted).body.startsWith('## ['), 'the gap line lands exactly on the first omitted section')
})

test('a vault named on the call is carried into every next call', () => {
  const md = longPage()
  const h = headOf(noteAnswer(md, { path: P, vault: 'atlas' }))
  assert.deepEqual(h.next, { path: P, vault: 'atlas', offset: h.cut })
  const p = part(noteAnswer(`# T\n## Big\n${prose(30000)}`, { path: P, vault: 'atlas', section: 'Big' }))
  assert.equal(p.next.vault, 'atlas')
})

/* --- 3. section ----------------------------------------------------------- */
test('section: the exact text, up to the next heading of the same or higher level', () => {
  const md = `# T\n\nintro\n\n## One\nb1\n### Sub A\nsa\n#### Deep\nd\n### Sub B\nsb\n\n## Two\nb2\n# Other\nother\n## Three\nb3`
  const body = (section) => part(noteAnswer(md, { path: P, section })).body
  assert.equal(body('One'), '## One\nb1\n### Sub A\nsa\n#### Deep\nd\n### Sub B\nsb\n\n', '## includes its ###s')
  assert.equal(body('Sub A'), '### Sub A\nsa\n#### Deep\nd\n', '### stops at the next ###, keeps its ####')
  assert.equal(body('Sub B'), '### Sub B\nsb\n\n', '### stops at the next ##')
  assert.equal(body('Two'), '## Two\nb2\n', 'a # ends a ##')
  assert.equal(body('Three'), '## Three\nb3', 'the last section runs to the end, no newline invented')
  for (const v of ['one', '  ONE  ', '## One', '##  one ']) assert.equal(body(v), body('One'), `matches ${JSON.stringify(v)}`)
})

test('section answer: one position line naming the page, the section and where it sits', () => {
  const md = `# T\n\n## One\nb1\n\n## Two\nb2\n`
  const answer = noteAnswer(md, { path: P, section: 'Two' })
  const at = md.indexOf('## Two')
  assert.equal(answer, `[${P} § "Two": chars ${at}–${md.length} of ${md.length}; section chars 0–${md.length - at} of ${md.length - at}]\n## Two\nb2\n`)
})

test('repeated headings are each addressable and each says the other exists', () => {
  const md = longPage()
  const first = noteAnswer(md, { path: P, section: 'Log' })
  const second = noteAnswer(md, { path: P, section: 'Log #2' })
  assert.ok(part(first).body.includes('first log'))
  assert.ok(part(second).body.includes('second log'))
  assert.match(first.split('\n')[0], /another section has this heading: "Log #2"/)
  assert.doesNotMatch(second.split('\n')[0], /another section/)
  // A literal "Log #2" keeps its name; the repeat steps around it.
  const lit = `## Log\na\n## Log #2\nb\n## Log\nc\n`
  assert.ok(part(noteAnswer(lit, { path: P, section: 'Log #2' })).body.includes('b'))
  assert.ok(part(noteAnswer(lit, { path: P, section: 'Log #3' })).body.includes('c'))
})

test('a heading inside a code fence is not a heading', () => {
  const md = `# T\n\n## Real\nbefore\n\`\`\`markdown\n## Log\nfenced\n\`\`\`\nafter\n\n~~~~\n## Other\n~~~\nstill fenced\n~~~~\n### Sub\ns\n`
  assert.throws(() => noteAnswer(md, { path: P, section: 'Other' }), /no section "Other"/)
  assert.equal(part(noteAnswer(md, { path: P, section: 'Real' })).body, md.slice(md.indexOf('## Real')), 'the fence does not end the section')
  // …including when the real one with that name comes later.
  const dup = `${md}## Log\nreal log\n`
  assert.equal(part(noteAnswer(dup, { path: P, section: 'Log' })).body, '## Log\nreal log\n')
})

test('an unknown section is an error listing the headings, bounded; an unknown offset names the size', () => {
  assert.throws(() => noteAnswer(longPage(), { path: P, section: 'nope' }), (e) => {
    assert.match(e.message, /no section "nope" in Wiki\/Long\.md/)
    for (const v of ['"Early"', '"Crossing sub"', '"Log #2"']) assert.ok(e.message.includes(v), v)
    return true
  })
  const many = `# T\n${Array.from({ length: 2000 }, (_, i) => `## entry ${i} ${'title '.repeat(10)}\nb\n`).join('')}`
  assert.throws(() => noteAnswer(many, { path: P, section: 'nope' }), (e) => {
    assert.ok(e.message.length <= CAP * 0.2, `${e.message.length}`)
    assert.match(e.message, /\d+ more not listed/)
    return true
  })
  assert.throws(() => noteAnswer('# Plain\nno sections', { path: P, section: 'nope' }), /no ## or ### sections/)
  assert.throws(() => noteAnswer('# T\n## A\nb\n', { path: P, section: 'A', offset: 50 }), /offset 50 is past the end of section "A": it has 7 chars/)
  assert.throws(() => noteAnswer('# T\n', { path: P, offset: 50 }), /offset 50 is past the end of the page: it has 4 chars/)
})

/* --- query_vault → get_note ----------------------------------------------- */
test('every `section` the semantic leg can print fetches the section holding that text', () => {
  const md = `${FM}# Title\n\nlead text\n\n## One\nb1\n\n### Sub\nb2\n\n#### Deep\nb3\n\n## Two\nbefore\n\`\`\`\n## Fenced\nin fence\n\`\`\`\nafter\n\n# Second\nsecond lead\n\n## Three\nb4\n`
  const body = stripFrontmatter(md)
  const fm = md.length - body.length
  const crumbs = chunkSections(body)
  assert.ok(crumbs.length >= 7, 'the fixture exercises the chunker')
  for (const c of crumbs) {
    const p = part(noteAnswer(md, { path: P, section: c.crumb }))
    const text = body.slice(c.start, c.end)
    assert.ok(p.body.includes(text), `${c.crumb} → missing ${JSON.stringify(text)}\n${p.body}`)
    assert.ok(p.a <= fm + c.start && fm + c.end <= p.b, c.crumb)
  }
  const fetch = (section) => part(noteAnswer(md, { path: P, section })).body
  assert.equal(fetch('Title › One › Sub › Deep'), '### Sub\nb2\n\n#### Deep\nb3\n\n', 'a #### lands on its ###')
  assert.ok(fetch('Title › Fenced').startsWith('## Two\n'), 'a fenced "heading" lands on the real section around it')
  assert.equal(fetch('Title'), '# Title\n\nlead text\n\n', 'a title-only crumb is the lead')
  assert.equal(fetch('Second'), '# Second\nsecond lead\n\n')
  assert.equal(noteAnswer(md, { path: P, section: '' }), md, 'an empty section (a page with no headings) is the page')
})

test('a long lead, reached by its breadcrumb, continues through its own value', () => {
  const lead = `# Title\n${prose(45000)}`
  const md = `${FM}${lead}\n## After\nb\n`
  const r = walk(md, { section: 'Title' })
  assert.equal(r.text, `${lead}\n`)
  assert.ok(r.calls >= 3)
})

/* --- 4. continuations ----------------------------------------------------- */
test('continuations over a whole page concatenate back byte for byte', () => {
  const md = longPage() + prose(70000, 'tail')
  const h = headOf(noteAnswer(md, { path: P }))
  const { text, calls } = walk(md, h.next)
  assert.equal(h.head + text, md)
  assert.ok(calls >= 3)
})

test('continuations over an over-cap section with no subsections (a 470 KB `## Log`)', () => {
  const log = `## Log\n${prose(470000, 'log')}`
  const md = `${FM}# Big\n\nA current state.\n\n${log}`
  const { text, calls } = walk(md, { section: 'Log' })
  assert.equal(text, log)
  assert.ok(calls >= 24)
  // every note's next call resumes where the last part ended
  const p = part(noteAnswer(md, { path: P, section: 'Log' }))
  assert.equal(p.next.offset, p.d)
  assert.equal(p.next.section, 'Log')
  assert.ok(p.body.endsWith('\n'), 'cut at a line boundary')
})

test('an over-cap section: its head, an outline of its ### subsections, and a continuation', () => {
  const subs = Array.from({ length: 6 }, (_, i) => `### Sub ${i}\n${prose(7000, `s${i}`)}`).join('')
  const sec = `## Big\nopening\n${subs}`
  const md = `# T\n\n${sec}\n## After\nb\n`
  const answer = noteAnswer(md, { path: P, section: 'Big' })
  assert.ok(answer.length <= CAP)
  const p = part(answer)
  assert.ok(p.body.startsWith('## Big\nopening'))
  const listed = [...p.rest.matchAll(/^- (\d+): (".*?")( \(the cut falls in this one\))?$/gm)].map((x) => JSON.parse(x[2]))
  assert.deepEqual(listed, ['Sub 2', 'Sub 3', 'Sub 4', 'Sub 5'])
  assert.match(p.rest, /Subsections past the cut/)
  const whole = walk(md, { section: 'Big' })
  assert.equal(whole.text, `${sec}\n`)
  for (const v of listed) assert.equal(walk(md, { section: v }).text.slice(0, v.length + 4), `### ${v}`)
  // a later part carries no outline — the first one already had it
  const later = noteAnswer(md, { path: P, section: 'Big', offset: p.next.offset })
  assert.doesNotMatch(later, /Subsections past the cut/)
})

test('lines longer than the cap are hard-cut, without losing a char or splitting a pair', () => {
  const astral = '😀'.repeat(30000) // 60,000 UTF-16 units, one line
  for (const md of [astral, `# T\n\n## A\n${astral}\n`, `${'a'.repeat(19990)}😀${'b'.repeat(50)}`]) {
    const args = md.includes('## A') ? { section: 'A' } : { offset: 1 }
    const prefix = md.includes('## A') ? '' : md[0]
    const { text } = walk(md, args)
    assert.equal(prefix + text, md.includes('## A') ? `## A\n${astral}\n` : md)
    let a = args
    while (a) {
      const p = part(noteAnswer(md, { path: P, ...a }))
      assert.ok(!/[\ud800-\udbff]$/.test(p.body), 'split a surrogate pair')
      a = p.next
    }
  }
})

test('the cap holds across sizes and path lengths, right at the boundaries', () => {
  const long = `Wiki/${'deep/'.repeat(40)}page.md`
  for (const size of [19990, 20000, 20001, 20100, 39000, 39999, 40001]) {
    const md = `# T\n\n## A\n${'y'.repeat(60)}\n${prose(size)}\n## B\nb\n`
    for (const args of [{}, { section: 'A' }, { offset: 7 }]) {
      const a = noteAnswer(md, { path: long, vault: 'atlas', ...args })
      assert.ok(a.length <= CAP, `${size} ${JSON.stringify(args)} → ${a.length}`)
    }
    let out = ''
    for (let a = { section: 'A' }; a; ) {
      const p = part(noteAnswer(md, { path: long, ...a }))
      assert.ok(p.first.length + p.body.length + p.rest.length + 1 <= CAP)
      out += p.body
      a = p.next
    }
    assert.equal(out, md.slice(md.indexOf('## A'), md.indexOf('## B')))
  }
})

test('the cap holds exactly when a hard-cut part also lists a subsection (no slack anywhere)', () => {
  // Found live on a ~1 MB log page: 20,002 chars. The note's "N more chars" was
  // sized at N = 0. Line cuts usually hide it; a hard cut fills the room exactly.
  for (const size of [25000, 99000, 150000, 1200000]) {
    const md = `# T\n\n## Big\n${'x'.repeat(size)}\n### Sub\nb\n`
    const a = noteAnswer(md, { path: P, section: 'Big' })
    assert.ok(a.length <= CAP, `${size} → ${a.length}`)
    assert.ok(a.length >= CAP - 10, `the room is used: ${a.length}`)
  }
})

/* --- through the real tool ------------------------------------------------- */
test('the MCP tool: schema carries section + offset, and the handler passes them to the page', async () => {
  const { tools } = await client.listTools()
  const def = tools.find((t) => t.name === 'get_note')
  assert.ok(def.inputSchema.properties.section)
  assert.ok(def.inputSchema.properties.offset)
  assert.deepEqual(def.inputSchema.required, ['path'], 'both stay optional')
  served = longPage()
  const call = async (arguments_) => {
    const r = await client.callTool({ name: 'get_note', arguments: arguments_ })
    return { isError: r.isError, text: r.content[0].text }
  }
  const head = await call({ path: P, vault: 'atlas' })
  assert.deepEqual(head.isError, undefined)
  assert.equal(headOf(head.text).next.vault, 'atlas')
  const sec = await call({ path: P, section: 'Log #2' })
  assert.equal(part(sec.text).body, '## Log\nsecond log\n')
  const off = await call({ path: P, offset: served.length - 5 })
  assert.equal(part(off.text).body, served.slice(-5))
  const bad = await call({ path: P, section: 'nope' })
  assert.equal(bad.isError, true)
  assert.match(bad.text, /no section "nope"/)
  assert.equal((await call({ path: P, offset: -1 })).isError, true, 'a negative offset is refused by the schema')
  served = '# Short\n'
  assert.equal((await call({ path: P })).text, '# Short\n')
})
