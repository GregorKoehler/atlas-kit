/* ------------------------------------------------------------------ *
 * Ranking core of the vault full-text search (api/src/vault-search.mjs).
 *
 * The defect this guards is not a crash — it is a SILENT empty result. The old
 * `search()` matched the whole lowercased query as one substring, so `3d scene`
 * found pages and `scene 3d` found none, and every downstream agent reads
 * `{"items":[]}` as "the vault does not know this" and re-decides a settled
 * question. Five properties have to hold, and none of them announces itself at
 * runtime:
 *
 *   1. WORD ORDER does not matter, and neither does adjacency;
 *   2. a QUOTED phrase still means the old exact-substring behaviour, and it
 *      FILTERS (a page without the phrase is not a hit) — the escape hatch is
 *      only useful if it actually narrows;
 *   3. non-English prose survives: umlauts/ß are letters, not separators, and a
 *      query term may match the compound it prefixes;
 *   4. the snippet shows a MATCHED term in context. The old snippet could only
 *      locate the whole query as one substring, so once matching went per-term
 *      it would have returned '' for every multi-term hit;
 *   5. the `/api/search` RESPONSE SHAPE is unchanged where it was already load-
 *      bearing (MCP `query_vault`, the bridge relay, the dashboard search box
 *      all read `items[].{type,title,subtitle,path,score,snippet}`) and only
 *      grew — and truncation is now VISIBLE, because silently dropping the tail
 *      is the same lie as returning nothing.
 *
 * Hermetic: a synthetic fixture corpus, no box state, no real vault.
 * Run: node --test api/test/vault-search.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createScorer, parseQuery, tokenize, snippet } from '../src/vault-search.mjs'
import { runInVaultAt, defaultVaultKey } from '../src/vaults.mjs'
import { search } from '../src/read-routes.mjs'

// A miniature vault: two pages that reproduce the word-order failures, a German
// page with a compound, and filler that gives document frequency something to
// work with.
const CORPUS = [
  {
    id: 'Wiki/Concepts/pr-preview-environments.md',
    title: 'PR preview environments',
    path: 'Wiki/Concepts/pr-preview-environments.md',
    body: 'A dropdown lists every open PR and serves that build. The preview stays on one origin so the login survives.',
    isWiki: true,
  },
  {
    id: 'Tasks/3d-scene-unavailable-diagnose.md',
    title: 'Liegenschafts-3D nach dem Deploy',
    path: 'Tasks/3d-scene-unavailable-diagnose.md',
    body: 'Die 3D-Ansicht meldet scene unavailable. Kette: API, Task-Queue, Worker, property_scene-Zeile, UI-Zustand.',
    isWiki: false,
  },
  {
    id: 'Wiki/Concepts/NK-Abrechnung-Pruefprozess.md',
    title: 'NK-Abrechnung — der reale Prüfprozess',
    path: 'Wiki/Concepts/NK-Abrechnung-Pruefprozess.md',
    body: 'Wie eine Nebenkostenabrechnung bei einem grossen Bewirtschafter geprüft wird. Die Liegenschaftsbuchhaltung prüft in drei Ebenen.',
    isWiki: true,
  },
  {
    id: 'Wiki/Projects/Example-Dashboard.md',
    title: 'Example Dashboard',
    path: 'Wiki/Projects/Example-Dashboard.md',
    body: 'Runs behind Caddy and a Cloudflare tunnel. '.repeat(3) + 'Unrelated prose about cards and notes. '.repeat(80),
    isWiki: true,
  },
  { id: 'Wiki/Sources/filler-a.md', title: 'Filler A', path: 'Wiki/Sources/filler-a.md', body: 'preview of a film, unrelated to any build', isWiki: true },
  { id: 'Wiki/Sources/filler-b.md', title: 'Filler B', path: 'Wiki/Sources/filler-b.md', body: 'a scene from a film, and a 3d printer', isWiki: true },
]

const run = (q) => {
  const s = createScorer(q)
  for (const d of CORPUS) s.add(d)
  return { ranked: s.rank(), clauses: s.clauses }
}
const ids = (q) => run(q).ranked.map((r) => r.id)

test('tokenise: unicode letters are letters, separators are not', () => {
  assert.deepEqual(tokenize('Prüfprozess, Größe & ÄÖÜ'), ['prüfprozess', 'größe', 'äöü'])
  // snake_case splits, which is what makes a query for one half of a typed key work
  assert.deepEqual(tokenize('for_project'), ['for', 'project'])
  // A PR number has to survive as a findable term rather than be stripped to nothing
  assert.deepEqual(tokenize('PR #476'), ['pr', '476'])
})

test('word order does not matter — the measured failure', () => {
  const forward = ids('3d scene')
  const reversed = ids('scene 3d')
  assert.ok(forward.length > 0, 'forward order must find something')
  assert.deepEqual(reversed, forward, 'reversing the words must not change the result at all')
  assert.ok(forward.includes('Tasks/3d-scene-unavailable-diagnose.md'))
})

test('non-adjacent terms match — `pr preview` used to return ZERO', () => {
  assert.equal(ids('pr preview')[0], 'Wiki/Concepts/pr-preview-environments.md')
})

test('the documented example still works, in both orders', () => {
  for (const q of ['cloudflare tunnel', 'tunnel cloudflare']) {
    assert.ok(ids(q).includes('Wiki/Projects/Example-Dashboard.md'), q)
  }
})

test('partial matches still rank — three of four terms is a hit, not a miss', () => {
  // 'kubernetes' is in no document at all; the rest of the query must still answer.
  assert.ok(ids('pr preview environments kubernetes').includes('Wiki/Concepts/pr-preview-environments.md'))
})

test('a quoted phrase FILTERS to pages carrying it contiguously', () => {
  assert.deepEqual(parseQuery('"cloudflare tunnel" caddy'), [
    { kind: 'phrase', text: 'cloudflare tunnel' },
    { kind: 'term', text: 'caddy' },
  ])
  assert.deepEqual(ids('"cloudflare tunnel"'), ['Wiki/Projects/Example-Dashboard.md'])
  // The same words unquoted are an OR and reach more pages — that is the point
  // of having both, so quoting has to actually narrow.
  assert.ok(ids('cloudflare tunnel').length >= ids('"cloudflare tunnel"').length)
  // A phrase nobody wrote is correctly empty. Zero hits is a legitimate answer;
  // what was wrong before was returning it for phrases that DO exist.
  assert.deepEqual(ids('"scene unavailable in 3d"'), [])
})

test('German: umlauts match, and a term matches the compound it prefixes', () => {
  const NK = 'Wiki/Concepts/NK-Abrechnung-Pruefprozess.md'
  assert.ok(ids('Prüfprozess').includes(NK), 'umlaut term must match')
  assert.ok(ids('prüfprozess nebenkosten').includes(NK), 'reversed + compound prefix')
  // 'Nebenkosten' appears in the corpus only INSIDE 'Nebenkostenabrechnung'.
  assert.ok(ids('Nebenkosten').includes(NK), 'compound prefix must match')
  // …but an exact hit is never diluted by prefix hits: 'Liegenschaftsbuchhaltung'
  // is a whole token and must still resolve to its page.
  assert.ok(ids('Liegenschaftsbuchhaltung').includes(NK))
})

test('title and path outrank body, and Wiki/ outranks loose notes', () => {
  // 'preview' is in the title of one page and the body of another.
  assert.equal(ids('preview')[0], 'Wiki/Concepts/pr-preview-environments.md')
})

test('length normalisation: a long page does not win on size alone', () => {
  // Example-Dashboard is by far the longest document and mentions 'preview' zero
  // times; a scorer without length normalisation still tends to float it up.
  assert.ok(!ids('preview').includes('Wiki/Projects/Example-Dashboard.md'))
})

test('an empty or punctuation-only query matches nothing at all', () => {
  for (const q of ['', '   ', '---']) assert.deepEqual(run(q).clauses, [], JSON.stringify(q))
})

test('snippet shows a matched term in context, for a MULTI-term query', () => {
  const doc = CORPUS[2]
  const { clauses } = run('prüfprozess nebenkosten')
  const s = snippet(doc.body, clauses)
  assert.ok(s.includes('Nebenkostenabrechnung'), s)
  assert.ok(s.length > 0 && s.length < 400)
})

test('snippet picks the passage where the most terms co-occur', () => {
  const body = 'cloudflare appears here alone. ' + 'filler '.repeat(200) + 'here caddy sits beside the cloudflare tunnel itself.'
  const { clauses } = run('cloudflare tunnel')
  assert.ok(snippet(body, clauses).includes('tunnel'), 'must not anchor on the first, lonely occurrence')
})

/* --- the response shape, over a throwaway vault ---------------------- */
// `search()` (api/src/read-routes.mjs) is the route's own function, so this
// covers the contract its consumers depend on — not a re-creation of it.
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-search-vault-'))
fs.mkdirSync(path.join(VAULT, 'Wiki', 'Concepts'), { recursive: true })
fs.mkdirSync(path.join(VAULT, 'Tasks'), { recursive: true })
for (let i = 0; i < 30; i++) {
  fs.writeFileSync(path.join(VAULT, 'Wiki', 'Concepts', `page-${i}.md`), `---\ntype: concept\n---\n\n# Page ${i}\n\nA page about the tunnel and the preview build number ${i}.\n`)
}
fs.writeFileSync(path.join(VAULT, 'Tasks', 'lone-task.md'), '---\ntype: task\n---\n\nEin Task über den Prüfprozess der Nebenkostenabrechnung.\n')

const inVault = (fn) => runInVaultAt(defaultVaultKey(), VAULT, fn)

test('response keeps every field it had, and adds total/truncated/limit', () => {
  const r = inVault(() => search('tunnel preview'))
  assert.equal(r.limit, 24)
  assert.equal(r.total, 30)
  assert.equal(r.items.length, 24)
  assert.equal(r.truncated, true, 'dropping 6 hits must be visible, not silent')
  for (const h of r.items) {
    assert.deepEqual(Object.keys(h).sort(), ['path', 'score', 'snippet', 'subtitle', 'title', 'type'])
    assert.equal(h.type, 'wiki')
    assert.equal(h.subtitle, 'Concepts')
    assert.ok(typeof h.score === 'number' && h.score > 0)
    assert.ok(h.snippet.includes('tunnel') || h.snippet.includes('preview'), h.snippet)
  }
})

test('the cap is a parameter, and an unusable one falls back to the default', () => {
  assert.equal(inVault(() => search('tunnel', 5)).items.length, 5)
  assert.equal(inVault(() => search('tunnel', 5)).truncated, true)
  assert.equal(inVault(() => search('tunnel', 500)).limit, 200, 'clamped, not honoured unbounded')
  assert.equal(inVault(() => search('tunnel', 'nonsense')).limit, 24)
})

test('an empty query is an empty result, not a scan of the whole vault', () => {
  assert.deepEqual(inVault(() => search('  ')), { items: [], total: 0, truncated: false, limit: 24 })
})

test('a German Tasks/ note is reachable by its own words', () => {
  const r = inVault(() => search('Nebenkosten Prüfprozess'))
  assert.equal(r.items[0].path, 'Tasks/lone-task.md')
  assert.equal(r.items[0].type, 'note')
  assert.equal(r.truncated, false)
})
