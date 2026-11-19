/* ------------------------------------------------------------------ *
 * Tests for Atlas page links in every chat view (vaultLinks.ts, chatNotes.ts,
 * and their use in markdown.tsx's renderInline / linkNodes).
 *
 * The ask (the follow-up to URL linking, linkify.ts): every
 * [[Page]] in a chat was a static grey span — AgentList renders its bubbles
 * with no `onWikiLink` — and a `Wiki/…/X.md` path an agent names was plain
 * text. Now both open the page in a small overlay over the chat.
 *
 * Pins: what a link target resolves to (title, alias, `#Heading` anchor, path
 * forms, case, the "not yet created" fallback that keeps a click from ever
 * being dead), relative `.md` links in a reader, which vault paths count, that
 * a code span never yields a wikilink, and that a vault's page list is fetched
 * ONCE however many links render (the chat poll must stay cheap) — Wiki/ +
 * Tasks/, with a page never shadowed by a same-named task.
 *
 * vaultLinks.ts / chatNotes.ts run via node's type-stripping (the
 * extensionless resolve hook registered first, like api.test.mjs) with a fake
 * `fetch`; markdown.tsx is JSX, so it is bundled in-memory with esbuild (as in
 * linkify.test.mjs) and its VNodes inspected — no DOM.
 * Run: node --test web/src/lib/vaultLinks.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

register('./ts-extensionless-loader.mjs', import.meta.url)
const { resolveTarget, parseWikiLink, relativeNotePath, vaultPathOf, knownPath, splitRefs, headingMatches } = await import('./vaultLinks.ts')

const PAGES = [
  { title: 'Demo-Project', path: 'Wiki/Projects/Demo-Project.md', folder: 'Wiki/Projects' },
  { title: 'LLM Wiki vs Atlas', path: 'Wiki/Concepts/LLM Wiki vs Atlas.md', folder: 'Wiki/Concepts' },
  { title: 'Atlas', path: 'Wiki/Projects/Atlas.md', folder: 'Wiki/Projects' },
  { title: 'atlas-retrieval-off-main-thread', path: 'Tasks/atlas-retrieval-off-main-thread.md', folder: 'Tasks' },
]

test('a title resolves by file name, any case', () => {
  assert.deepEqual(resolveTarget('Demo-Project', PAGES), { path: 'Wiki/Projects/Demo-Project.md', missing: null, anchor: undefined })
  assert.equal(resolveTarget('demo-project', PAGES).path, 'Wiki/Projects/Demo-Project.md')
  assert.equal(resolveTarget('LLM Wiki vs Atlas', PAGES).path, 'Wiki/Concepts/LLM Wiki vs Atlas.md')
  assert.equal(resolveTarget('atlas-retrieval-off-main-thread', PAGES).path, 'Tasks/atlas-retrieval-off-main-thread.md')
})

test('an alias shows its label and resolves its target', () => {
  assert.deepEqual(parseWikiLink('Demo-Project|the dashboard'), { target: 'Demo-Project', label: 'the dashboard' })
  assert.deepEqual(parseWikiLink(' Atlas '), { target: 'Atlas', label: 'Atlas' })
  assert.deepEqual(parseWikiLink('Atlas|'), { target: 'Atlas', label: 'Atlas' }, 'an empty alias falls back to the target')
  assert.equal(resolveTarget(parseWikiLink('Demo-Project|the dashboard').target, PAGES).path, 'Wiki/Projects/Demo-Project.md')
})

test('a #Heading anchor opens the page and carries the heading', () => {
  assert.deepEqual(resolveTarget('Demo-Project#Relation to this Atlas', PAGES), {
    path: 'Wiki/Projects/Demo-Project.md',
    missing: null,
    anchor: 'Relation to this Atlas',
  })
  assert.equal(resolveTarget(parseWikiLink('Atlas#Goal|goal').target, PAGES).anchor, 'Goal')
  assert.equal(resolveTarget('Atlas#', PAGES).anchor, undefined)
  assert.ok(headingMatches('Relation to this Atlas', 'relation-to-this-atlas'), 'a slugged anchor matches too')
  assert.ok(headingMatches('Ü-Wörter & mehr', 'ü wörter mehr'))
  assert.ok(!headingMatches('Relation', 'Relation to this Atlas'))
  assert.ok(!headingMatches('anything', '  '))
})

test('path forms: full path, without .md, a path tail, a leading ./', () => {
  for (const t of ['Wiki/Projects/Atlas.md', 'Wiki/Projects/Atlas', 'wiki/projects/atlas.md', 'Projects/Atlas', './Wiki/Projects/Atlas.md']) {
    assert.equal(resolveTarget(t, PAGES).path, 'Wiki/Projects/Atlas.md', t)
  }
  assert.equal(resolveTarget('Tasks/atlas-retrieval-off-main-thread', PAGES).path, 'Tasks/atlas-retrieval-off-main-thread.md')
  assert.equal(resolveTarget('Wiki/Concepts/LLM Wiki vs Atlas.md#Two', PAGES).anchor, 'Two')
})

test('an explicit .md path the list lacks still opens by path (a reader lists Wiki/ only)', () => {
  assert.deepEqual(resolveTarget('Tasks/not-listed.md', []), { path: 'Tasks/not-listed.md', missing: null, anchor: undefined })
})

test('an unknown title is the "not yet created" state, never a dead click', () => {
  assert.deepEqual(resolveTarget('No Such Page', PAGES), { path: null, missing: 'No Such Page', anchor: undefined })
  assert.deepEqual(resolveTarget('No Such Page#Part', PAGES), { path: null, missing: 'No Such Page', anchor: 'Part' })
  assert.equal(resolveTarget('Projects/Nope', PAGES).missing, 'Projects/Nope')
  assert.equal(resolveTarget('Atlas', null).missing, 'Atlas', 'no page list yet → missing, not a throw')
})

test('relative .md links in a reader resolve against the note folder', () => {
  assert.equal(relativeNotePath('Wiki/Projects', '../Concepts/LLM%20Wiki%20vs%20Atlas.md'), 'Wiki/Concepts/LLM Wiki vs Atlas.md')
  assert.equal(relativeNotePath('Wiki/Projects', 'Atlas.md#Goal'), 'Wiki/Projects/Atlas.md#Goal')
  assert.equal(relativeNotePath('Wiki/Projects', './Atlas.md'), 'Wiki/Projects/Atlas.md')
  assert.equal(relativeNotePath('Wiki/Projects', '../../Tasks/x.md'), 'Tasks/x.md')
  assert.equal(relativeNotePath('Wiki/Projects', '/Tasks/x.md'), 'Tasks/x.md', 'a leading / is the vault root')
  for (const h of ['../../../etc/passwd.md', 'https://x.y/a.md', 'mailto:a@b.md', '//x.y/a.md', 'image.png', 'notes.txt']) {
    assert.equal(relativeNotePath('Wiki/Projects', h), null, h)
  }
})

test('vault paths: Wiki/ and Tasks/ .md only, never glued to another path', () => {
  assert.equal(vaultPathOf('Wiki/Concepts/LLM Wiki vs Atlas.md'), 'Wiki/Concepts/LLM Wiki vs Atlas.md', 'a code span may hold spaces')
  assert.equal(vaultPathOf(' Tasks/x.md '), 'Tasks/x.md')
  for (const c of ['web/src/lib/markdown.tsx', 'Wiki/index', 'raw/x.md', 'cat Wiki/x.md', 'Wiki/x.md and more']) {
    assert.equal(vaultPathOf(c), null, c)
  }
  const paths = (s) => splitRefs(s).filter((p) => typeof p !== 'string' && p.kind === 'path').map((p) => p.path)
  assert.deepEqual(paths('see Wiki/Projects/Atlas.md, and Tasks/x.md.'), ['Wiki/Projects/Atlas.md', 'Tasks/x.md'])
  assert.deepEqual(paths('(Wiki/Projects/Atlas.md)'), ['Wiki/Projects/Atlas.md'])
  assert.deepEqual(paths('/srv/vault/Wiki/A.md docs/Tasks/b.md Wiki/A.mdx myWiki/A.md'), [])
  assert.equal(knownPath(PAGES, 'wiki/projects/atlas.md'), 'Wiki/Projects/Atlas.md', 'opens the real spelling')
  assert.equal(knownPath(PAGES, 'Wiki/Projects/Nope.md'), null)
})

test('plain text splits into text, URLs, wikilinks and paths — byte-identical', () => {
  const s = 'PR https://github.com/o/r/pull/585. See [[Atlas|the atlas]] and Tasks/x.md, ok?'
  const parts = splitRefs(s)
  assert.equal(parts.map((p) => (typeof p === 'string' ? p : p.text)).join(''), s)
  assert.deepEqual(
    parts.filter((p) => typeof p !== 'string').map((p) => p.kind),
    ['url', 'wiki', 'path'],
  )
  assert.deepEqual(splitRefs('no refs here'), ['no refs here'])
  assert.deepEqual(splitRefs('javascript:alert(1)'), ['javascript:alert(1)'])
})

/* --- the page list: one fetch per vault, Wiki/ + Tasks/ -------------- */
test('a vault page list is fetched once however many callers, Wiki/ first', async () => {
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    await new Promise((r) => setTimeout(r, 5))
    const body = url.includes('/wiki/pages')
      ? { items: [{ title: 'Atlas', path: 'Wiki/Projects/Atlas.md', folder: 'Wiki/Projects' }] }
      : { tasks: [{ path: 'Tasks/Atlas.md' }, { path: 'Tasks/do-it.md' }] }
    return { ok: true, json: async () => body }
  }
  const { loadChatPages } = await import('./chatNotes.ts')
  const lists = await Promise.all([loadChatPages('second-vault'), loadChatPages('second-vault'), loadChatPages('second-vault')])
  assert.equal(calls.length, 2, 'one wiki/pages + one tasks request for three callers')
  assert.ok(calls.every((u) => u.includes('vault=second-vault')), 'the chat vault is the one asked')
  assert.deepEqual(lists[0].map((p) => p.path), ['Wiki/Projects/Atlas.md', 'Tasks/Atlas.md', 'Tasks/do-it.md'])
  assert.equal(resolveTarget('Atlas', lists[0]).path, 'Wiki/Projects/Atlas.md', 'a task never shadows a page')
  assert.equal(resolveTarget('do-it', lists[0]).path, 'Tasks/do-it.md')
  await loadChatPages('second-vault')
  assert.equal(calls.length, 2, 'a cached list is not refetched')
  await loadChatPages('second-vault', 0)
  assert.equal(calls.length, 4, 'a click asking for a fresher list refetches')
})

/* --- through the real renderInline -------------------------------- */
const md = await (async () => {
  const r = await build({
    entryPoints: [fileURLToPath(new URL('./markdown.tsx', import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    logLevel: 'silent',
  })
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`)
})()

// Flatten into ['text', {wiki: target, label}, {path, …}, {code}, {a}] —
// WikiRef / VaultPathRef are the components that decide (from the reader's
// handler or the chat's ChatVault) whether they render live.
function shape(nodes) {
  const out = []
  const textOf = (n) => (n == null || typeof n === 'boolean' ? '' : typeof n !== 'object' ? String(n) : Array.isArray(n) ? n.map(textOf).join('') : textOf(n.props?.children))
  const walk = (n) => {
    if (n == null || typeof n === 'boolean') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (typeof n !== 'object') return void out.push(String(n))
    const name = typeof n.type === 'function' ? n.type.name : n.type
    if (name === 'WikiRef') return void out.push({ wiki: n.props.target, label: textOf(n.props.label) })
    if (name === 'VaultPathRef') return void out.push({ path: n.props.path, in: shape(n.props.children) })
    if (name === 'ExtLink') return void out.push({ a: n.props.href })
    if (name === 'code') return void out.push({ code: textOf(n) })
    out.push({ [name]: shape(n.props.children) })
  }
  walk(nodes)
  return out
}
const inline = (s, opts = {}) => shape(md.renderInline(s, opts))

test('renderInline: aliases and anchors reach the link target', () => {
  assert.deepEqual(inline('see [[Demo-Project|the dashboard]]'), ['see ', { wiki: 'Demo-Project', label: 'the dashboard' }])
  assert.deepEqual(inline('[[Atlas#Goal]]'), [{ wiki: 'Atlas#Goal', label: 'Atlas#Goal' }])
  assert.deepEqual(inline('**[[Atlas]]**'), [{ strong: [{ wiki: 'Atlas', label: 'Atlas' }] }], 'inside bold too')
})

test('renderInline: no wikilink inside a code span; a code span holding a vault path is a path ref', () => {
  assert.deepEqual(inline('`[[Atlas]]`'), [{ code: '[[Atlas]]' }])
  assert.deepEqual(inline('`Wiki/Concepts/LLM Wiki vs Atlas.md`'), [
    { path: 'Wiki/Concepts/LLM Wiki vs Atlas.md', in: [{ code: 'Wiki/Concepts/LLM Wiki vs Atlas.md' }] },
  ])
  assert.deepEqual(inline('`cat Wiki/x.md`'), [{ code: 'cat Wiki/x.md' }])
  assert.deepEqual(inline('read Tasks/x.md now'), ['read ', { path: 'Tasks/x.md', in: ['Tasks/x.md'] }, ' now'])
  assert.deepEqual(inline('https://github.com/o/r/blob/main/Wiki/x.md'), [{ a: 'https://github.com/o/r/blob/main/Wiki/x.md' }], 'a URL wins')
})

test('renderInline: a relative .md link follows in a reader, stays text elsewhere', () => {
  const opts = { onWikiLink: () => {}, basePath: 'Wiki/Projects' }
  assert.deepEqual(inline('[the atlas](../Concepts/Atlas.md#Goal)', opts), [{ wiki: 'Wiki/Concepts/Atlas.md#Goal', label: 'the atlas' }])
  assert.deepEqual(inline('[the atlas](../Concepts/Atlas.md)'), ['[the atlas](../Concepts/Atlas.md)'])
  assert.deepEqual(inline('[x](javascript:alert(1).md)', opts), ['[x](javascript:alert(1)', '.md)'])
})

test('linkNodes (operator bubbles): wikilinks and paths join the URLs', () => {
  assert.deepEqual(shape(md.linkNodes('look at [[Atlas|it]] + Wiki/Projects/Atlas.md')), [
    'look at ',
    { wiki: 'Atlas', label: 'it' },
    ' + ',
    { path: 'Wiki/Projects/Atlas.md', in: ['Wiki/Projects/Atlas.md'] },
  ])
  assert.equal(md.linkNodes('nothing to link'), 'nothing to link')
})
