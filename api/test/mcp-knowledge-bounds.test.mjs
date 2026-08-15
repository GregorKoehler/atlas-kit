/* ------------------------------------------------------------------ *
 * The seven knowledge READ tools must be BOUNDED, and `recent_activity` must
 * mean what its name says.
 *
 * The defect, found by an agent using the tool for real (not by CI, which never
 * called it): `recent_activity` returned the ENTIRE append-only Wiki/log.md —
 * over a million chars on a mature vault, OLDEST first, no `limit` in its schema
 * at all. A non-truncating caller blows its response budget outright; a
 * truncating one (a remote relay's 20,000-char cap) keeps the OLDEST weeks, cut
 * mid-word. The relay is correct; the defect is upstream, here. Its siblings are
 * the same class: wiki_graph ~1.4 MB, get_note 600 KB for one page, wiki_index
 * 225 KB, wiki_pages 178 KB — all linear in the size of the vault.
 *
 * So this file pins the properties a diff can silently lose:
 *   1. NEWEST first, sliced by whole ENTRY, never mid-entry,
 *   2. `limit` respected, and the hard char cap holds regardless of it,
 *   3. an odd or absent vault log degrades to an empty answer, not a crash,
 *   4. every JSON answer still PARSES after being bounded (a byte-cut would not),
 *   5. the bound is self-describing — it says what it dropped and what to call.
 *
 * A fake read API stands in for the dashboard's read routes, and the tools are
 * driven over an in-memory MCP transport. No vault, no HTTP server on a fixed
 * port.
 *
 * Run: node --test api/test/mcp-knowledge-bounds.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The documented hard cap on any knowledge answer (tools.mjs RESPONSE_MAX).
// Asserted as a literal here because it IS the contract.
const CAP = 20000

/* --- two vaults, so `vault` is a real choice (and the param is registered) -- */
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-mcp-bounds-'))
const VAULTS_FILE = path.join(DIR, 'vaults.json')
fs.writeFileSync(
  VAULTS_FILE,
  JSON.stringify({ atlas: { path: '/vault-atlas', label: 'Atlas', default: true }, plain: { path: '/vault', label: 'Plain' } }),
)
process.env.VAULTS_FILE = VAULTS_FILE

/* --- fixtures ---------------------------------------------------------- */
// One log entry: a `## [date] op | title` heading plus a body of `size` chars.
const entry = (day, op, title, size = 40) =>
  `## [2026-07-${String(day).padStart(2, '0')}] ${op} | ${title}\n${'body '.repeat(Math.ceil(size / 5)).slice(0, size)}`

// Oldest first, exactly as the vault stores it.
const logOf = (n, size) => `---\ntype: log\n---\n\n# Log\n\nAppend-only.\n\n` + Array.from({ length: n }, (_, i) => entry(i + 1, 'ingest', `entry ${i + 1}`, size)).join('\n\n') + '\n'

const fixtures = {
  log: logOf(6, 40),
  index: '# Index\n\n- [[Atlas-Kit]] — the runtime\n',
  note: '# Atlas Kit\n\nnotes\n',
  pages: {
    items: [
      { title: 'Atlas Kit', path: 'Wiki/Projects/Atlas-Kit.md', folder: 'Wiki/Projects', mtime: 1 },
      { title: 'Atlas', path: 'Wiki/Projects/Atlas.md', folder: 'Wiki/Projects', mtime: 2 },
      // The trap the first cut of the `folder` filter fell into: a FILENAME
      // containing the folder word must not match `folder: "Projects"`.
      { title: 'Megaprojects', path: 'Wiki/Concepts/Desert-Megaprojects.md', folder: 'Wiki/Concepts', mtime: 3 },
    ],
  },
  graph: {
    nodes: [
      { id: 'Atlas-Kit', title: 'Atlas Kit', path: 'Wiki/Projects/Atlas-Kit.md', type: 'Projects', degree: 3 },
      { id: 'Atlas', title: 'Atlas', path: 'Wiki/Projects/Atlas.md', type: 'Projects', degree: 2 },
      { id: 'Caddy', title: 'Caddy', path: 'Wiki/Organizations/Caddy.md', type: 'Organizations', degree: 1 },
    ],
    links: [
      { source: 'Atlas-Kit', target: 'Atlas', type: 'depends_on', family: 'structural', directed: true },
      { source: 'Atlas-Kit', target: 'Caddy', type: 'link', family: 'link', directed: false },
      { source: 'Atlas', target: 'Caddy', type: 'link', family: 'link', directed: false },
    ],
  },
  atlasQuery: { generated: 'now', count: 3, truncated: false, pages: [{ path: 'Tasks/a.md', title: 'a' }] },
  search: { items: [{ path: 'Wiki/Projects/Atlas-Kit.md', snippet: 'a hit' }], total: 1, truncated: false, limit: 24 },
}

/* --- the fake read API (what the tool handlers call) ------------------- */
const hits = []
const api = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const url = new URL(req.url, 'http://api')
    const vault = url.searchParams.get('vault')
    hits.push({ path: url.pathname, vault })
    const json = (o) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(o))
    }
    const text = (s, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(s)
    }
    if (vault && vault !== 'atlas' && vault !== 'plain') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end('{"error":"unknown vault"}')
    }
    // `plain` stands for a vault whose log is absent (404) — the degradation case.
    if (url.pathname === '/api/wiki/log') return vault === 'plain' ? text('', 404) : text(fixtures.log)
    if (url.pathname === '/api/wiki/index') return text(fixtures.index)
    if (url.pathname === '/api/note') return text(fixtures.note)
    if (url.pathname === '/api/wiki/pages') return json(fixtures.pages)
    if (url.pathname === '/api/wiki/graph') return json(fixtures.graph)
    if (url.pathname === '/api/atlas/query') return json(fixtures.atlasQuery)
    if (url.pathname === '/api/search') return json(fixtures.search)
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
})
await new Promise((r) => api.listen(0, '127.0.0.1', r))
process.env.ATLAS_API_BASE = `http://127.0.0.1:${api.address().port}`
test.after(() => api.close())

const { buildServer, KNOWLEDGE_TOOLS, recentLogEntries, capLegs } = await import('../src/mcp/tools.mjs')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

const server = buildServer({ knowledgeOnly: true })
const [clientT, serverT] = InMemoryTransport.createLinkedPair()
const client = new Client({ name: 'mcp-bounds-test', version: '0' })
await Promise.all([server.connect(serverT), client.connect(clientT)])

// Call a tool the way an agent does; returns its text (or throws on isError).
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 20000 })
  const text = (r.content || []).map((c) => c.text || '').join('\n')
  if (r.isError) throw new Error(text)
  return text
}
const callJson = async (name, args) => JSON.parse(await call(name, args))

/* --- 1. recent_activity: newest first, whole entries, `limit` ---------- */

test('the newest entries come back FIRST — the bug was the head of an append-only file', () => {
  const out = recentLogEntries(fixtures.log, { limit: 3 })
  const titles = [...out.matchAll(/^## \[[^\]]+\] \S+ \| (.*)$/gm)].map((m) => m[1])
  assert.deepEqual(titles, ['entry 6', 'entry 5', 'entry 4'])
  assert.match(out, /newest 3 of 6 entries/)
  // and NOT the preamble/oldest end of the file
  assert.doesNotMatch(out, /entry 1\b/)
  assert.doesNotMatch(out, /Append-only\./)
})

test('`limit` counts whole ENTRIES, and the default is small', () => {
  assert.equal([...recentLogEntries(fixtures.log, { limit: 1 }).matchAll(/^## \[/gm)].length, 1)
  assert.equal([...recentLogEntries(fixtures.log, { limit: 6 }).matchAll(/^## \[/gm)].length, 6)
  // asking for more than exist is not an error
  assert.equal([...recentLogEntries(fixtures.log, { limit: 99 }).matchAll(/^## \[/gm)].length, 6)
  // default: 10 entries of a 40-entry log, newest first
  const def = recentLogEntries(logOf(40, 40))
  assert.equal([...def.matchAll(/^## \[/gm)].length, 10)
  assert.match(def, /newest 10 of 40 entries/)
})

test('an entry is returned WHOLE — no mid-entry, no mid-word cut', () => {
  // 30 entries of ~900 chars: only some fit a 5,000-char cap.
  const out = recentLogEntries(logOf(30, 900), { limit: 30, max: 5000 })
  assert.ok(out.length <= 5000, `cap: ${out.length}`)
  const bodies = out.split('\n\n').filter((b) => b.startsWith('## ['))
  assert.ok(bodies.length >= 2 && bodies.length < 30, `kept ${bodies.length} of 30`)
  // every kept entry still carries its full 900-char body
  for (const b of bodies) assert.ok(b.length >= 900, `entry cut short: ${b.length}`)
  assert.match(out, /requested entries dropped to fit the 5000-char response cap; these are the newest/)
})

test('the hard cap holds however absurd `limit` is — and when ONE entry exceeds it', () => {
  for (const max of [800, 5000, 20000]) {
    const out = recentLogEntries(logOf(200, 1500), { limit: 100, max })
    assert.ok(out.length <= max, `limit=100 max=${max} → ${out.length}`)
  }
  // a single entry longer than the whole cap: the cap wins, loudly
  const one = recentLogEntries(logOf(1, 4000), { limit: 10, max: 1000 })
  assert.ok(one.length <= 1000, `${one.length}`)
  assert.match(one, /truncated: \d+ of \d+ chars/)
})

/* --- 2. odd and absent logs degrade, they do not crash ----------------- */

test('a log with no `## [date]` entries keeps the TAIL and says so; an empty one is empty', () => {
  const flat = '# Log\n\n' + Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')
  const out = recentLogEntries(flat, { max: 500 })
  assert.ok(out.length <= 500)
  assert.match(out, /no `## \[date\]` entries found/)
  assert.match(out, /line 399/, 'the newest end of an append-only file is its tail')
  assert.doesNotMatch(out, /line 0\b/)
  // short, entry-less log → returned whole
  assert.match(recentLogEntries('# Log\n\nnothing yet'), /nothing yet/)
  // empty / missing
  for (const md of ['', '   ', null, undefined]) assert.match(recentLogEntries(md), /the log is empty/)
})

test('a vault with NO Wiki/log.md is an empty change log, not a tool error', async () => {
  const out = await call('recent_activity', { vault: 'plain' }) // the fake API 404s this one
  assert.match(out, /the log is empty/)
  // an unknown vault is still a real error — a bad argument, not empty data
  await assert.rejects(() => call('recent_activity', { vault: 'nope' }), /400/)
})

test('recent_activity reads the named vault, and accepts `limit` over MCP', async () => {
  hits.length = 0
  const out = await call('recent_activity', { vault: 'atlas', limit: 2 })
  assert.equal(hits.at(-1).path, '/api/wiki/log')
  assert.equal(hits.at(-1).vault, 'atlas')
  assert.equal([...out.matchAll(/^## \[/gm)].length, 2)
})

/* --- 3. the siblings: bounded, parseable, self-describing -------------- */

test('every knowledge tool answers under the cap on a vault-sized corpus', async () => {
  const big = {
    log: logOf(400, 1500), //   ~600 KB
    index: '# Index\n\n' + Array.from({ length: 4000 }, (_, i) => `- [[page-${i}]] — ${'summary '.repeat(12)}`).join('\n'),
    note: '# Huge\n\n' + Array.from({ length: 8000 }, (_, i) => `paragraph ${i} ${'text '.repeat(10)}`).join('\n\n'),
    pages: { items: Array.from({ length: 1500 }, (_, i) => ({ title: `page ${i}`, path: `Wiki/Concepts/page-${i}.md`, folder: 'Wiki/Concepts', mtime: i })) },
    graph: {
      nodes: Array.from({ length: 1500 }, (_, i) => ({ id: `n${i}`, title: `node ${i}`, path: `Wiki/Concepts/n${i}.md`, type: 'Concepts', degree: i % 40 })),
      links: Array.from({ length: 6000 }, (_, i) => ({ source: 'n0', target: `n${i % 1500}`, type: 'link', family: 'link', directed: false })),
    },
    atlasQuery: {
      generated: 'now',
      count: 1500,
      truncated: true,
      pages: Array.from({ length: 200 }, (_, i) => ({ path: `Tasks/t${i}.md`, title: `task ${i}`, props: { status: 'next', body: 'x'.repeat(300) } })),
    },
  }
  const saved = { ...fixtures }
  Object.assign(fixtures, big)
  try {
    const calls = [
      ['recent_activity', { limit: 100 }],
      ['wiki_index', {}],
      ['get_note', { path: 'Wiki/Huge.md' }],
      ['wiki_pages', {}],
      ['wiki_graph', {}],
      ['wiki_graph', { limit: 500 }],
      ['wiki_graph', { node: 'n0' }],
      ['query_atlas', { limit: 200 }],
    ]
    for (const [name, args] of calls) {
      const out = await call(name, args)
      assert.ok(out.length > 0, `${name} returned nothing`)
      assert.ok(out.length <= CAP, `${name} ${JSON.stringify(args)} → ${out.length} chars, over the ${CAP} cap`)
      // a bounded JSON answer must still parse — dropping rows, not bytes
      if (out.trimStart().startsWith('{')) assert.doesNotThrow(() => JSON.parse(out), `${name} returned unparseable JSON`)
      else assert.match(out, /truncated|Recent activity|# /, `${name} truncation is not self-describing`)
    }
    // …and each says what it dropped, in terms the agent can act on
    assert.match(await call('wiki_index', {}), /truncated: \d+ of \d+ chars — the catalog continues/)
    assert.match(await call('get_note', { path: 'Wiki/Huge.md' }), /truncated: \d+ of \d+ chars — this page is long/)
    const pages = await callJson('wiki_pages', {})
    assert.equal(pages.total, 1500)
    assert.ok(pages.items.length < 1500 && pages.items.length > 10)
    assert.equal(pages.truncated, true)
    assert.match(pages.note, /bounded: \d+ of 1500 items/)
    const q = await callJson('query_atlas', { limit: 200 })
    assert.ok(q.pages.length < 200)
    assert.match(q.note, /bounded: \d+ of 200 pages/)
    // a bound on a payload that ALREADY carries guidance keeps both
    const hubs = await callJson('wiki_graph', { limit: 500 })
    assert.ok(hubs.hubs.length < 500)
    assert.match(hubs.note, /bounded: \d+ of 500 hubs/)
    assert.match(hubs.note, /pass `node`/)
  } finally {
    Object.assign(fixtures, saved)
  }
})

test('wiki_pages: `folder` scopes by DIRECTORY, and title+path is all a page row is', async () => {
  const scoped = await callJson('wiki_pages', { folder: 'Projects' })
  assert.deepEqual(scoped.items.map((p) => p.path).sort(), ['Wiki/Projects/Atlas-Kit.md', 'Wiki/Projects/Atlas.md'])
  assert.equal(scoped.total, 2, 'a filename containing "projects" is not in the Projects folder')
  assert.deepEqual(Object.keys(scoped.items[0]).sort(), ['path', 'title'])
  assert.equal((await callJson('wiki_pages', { limit: 1 })).items.length, 1)
})

test('wiki_graph: a SUMMARY by default, one page’s edges with `node`', async () => {
  const sum = await callJson('wiki_graph', {})
  assert.deepEqual({ nodes: sum.nodes, links: sum.links }, { nodes: 3, links: 3 })
  assert.deepEqual(sum.byCategory, { Projects: 2, Organizations: 1 })
  assert.equal(sum.hubs[0].id, 'Atlas-Kit', 'hubs are highest-degree first')
  assert.match(sum.note, /pass `node`/)
  assert.ok(!Array.isArray(sum.nodes), 'the summary must not carry the full node list')

  const focus = await callJson('wiki_graph', { node: 'atlas kit' }) // partial/title/case-insensitive
  assert.equal(focus.node.id, 'Atlas-Kit')
  assert.equal(focus.edgeCount, 2)
  assert.deepEqual(focus.edges.map((l) => l.target).sort(), ['Atlas', 'Caddy'])
  assert.equal((await callJson('wiki_graph', { node: 'Atlas-Kit', limit: 1 })).edges.length, 1)

  const miss = await callJson('wiki_graph', { node: 'not-a-page' })
  assert.equal(miss.node, null)
  assert.match(miss.note, /no page matching/)
})

test('the knowledge surface is still exactly the seven read tools', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort()
  assert.deepEqual(names, [...KNOWLEDGE_TOOLS].sort())
  // recent_activity's `limit` is part of the schema now — it silently was not
  const ra = (await client.listTools()).tools.find((t) => t.name === 'recent_activity')
  assert.ok(ra.inputSchema.properties.limit, 'recent_activity has no limit parameter')
  assert.match(ra.description, /NEWEST/)
})

/* --- the ADDON legs are bounded on their own terms ------------------------ */

test('capLegs bounds addon legs WITHOUT touching items or `truncated`', () => {
  const row = (i) => ({ type: 'note', title: `row ${i}`, subtitle: 'x', path: `P${i}.md`, snippet: 'y'.repeat(400), similarity: 0.5 })
  const payload = {
    items: [{ type: 'wiki', title: 'lexical', subtitle: 'Wiki', path: 'Wiki/A.md', snippet: 'z', score: 9 }],
    total: 1,
    truncated: false, // ⚠️ means "the FULL-TEXT leg had more matches than limit"
    limit: 24,
    legs: [
      { key: 'a', label: 'A', addon: 'demo', available: true, items: Array.from({ length: 60 }, (_, i) => row(i)) },
      { key: 'b', label: 'B', addon: 'demo2', available: true, items: Array.from({ length: 60 }, (_, i) => row(i)) },
    ],
  }
  const out = capLegs(payload, CAP)
  const size = JSON.stringify(out, null, 2).length
  assert.ok(size <= CAP, `bounded answer is ${size} chars, over the ${CAP} cap`)
  assert.ok(out.legsTruncated)
  assert.match(out.legsNote, /of 120 addon-leg rows dropped/)
  // The full-text half is untouched, and `truncated` still means what it meant.
  assert.deepEqual(out.items, payload.items)
  assert.equal(out.truncated, false)
  assert.equal(out.total, 1)
  // An even cut: the legs are unioned, not ranked against each other, so there is
  // no principled way to spend one leg's budget on the other.
  assert.equal(out.legs[0].items.length, out.legs[1].items.length)
  assert.ok(JSON.parse(JSON.stringify(out)), 'still parses — a byte-cut would not')
})

test('capLegs is a no-op when it fits, and when there are no addon legs at all', () => {
  const small = { items: [], total: 0, truncated: false, limit: 24, legs: [{ key: 'a', label: 'A', addon: 'd', available: true, items: [] }] }
  assert.equal(capLegs(small, CAP), small, 'same object back — nothing to bound')
  const none = { items: [], total: 0, truncated: false, limit: 24 }
  assert.equal(capLegs(none, CAP), none)
})
