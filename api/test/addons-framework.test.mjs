/* ------------------------------------------------------------------ *
 * The optional-addon framework (api/src/addons.mjs) and the four core surfaces
 * it feeds: GET /api/addons, the extra search legs on GET /api/search, the
 * read-time scorecard join, and the spawn-evidence seam.
 *
 * 🔴 THE LOAD-BEARING ASSERTION IS THE ZERO-ADDON ONE. A kit with nothing
 * enabled must answer EXACTLY as it did before addons existed — no `legs` key on
 * a search response, no scorecard change, an inert evidence seam. That is what
 * makes an addon genuinely optional rather than "off by a flag but still in
 * every code path", and it is asserted FIRST, before anything is loaded: the
 * registry is per-process and filled once, so "before loadAddons()" and "no
 * addons enabled" are the same state by construction.
 *
 * Everything after it runs against two fixture addons under
 * test/fixtures/addons/ — `demo` (exercises every hook) and `broken` (throws on
 * import, and must be recorded and skipped rather than fatal).
 *
 * Run: node --test api/test/addons-framework.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// A tiny throwaway vault + data dir, pinned BEFORE the modules under test are
// imported (read-routes freezes VAULT/DATA_DIR at import time).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-addons-'))
const vault = path.join(root, 'vault')
fs.mkdirSync(path.join(vault, 'Wiki'), { recursive: true })
fs.mkdirSync(path.join(vault, 'data'), { recursive: true })
fs.writeFileSync(path.join(vault, 'Wiki', 'Widget.md'), '# Widget\n\nA widget is a small mechanical thing.\n')
fs.writeFileSync(path.join(vault, 'data', 'scorecard.json'), JSON.stringify({ generated: '2026-01-01T00:00:00Z', stats: [{ label: 'Core tile', value: '7' }] }))
process.env.VAULT_PATH = vault
process.env.DATA_DIR = path.join(vault, 'data')
process.env.ATLAS_ADDONS_DIR = path.join(HERE, 'fixtures', 'addons')

const { loadAddons, enabledNames, addonList, addonErrors, addonCron, addonRouter, addonMcpTools, addonEvidenceLeg, addonScorecardStats } = await import('../src/addons.mjs')
const { readRouter, searchAllLegs } = await import('../src/read-routes.mjs')
const { subAsks, semanticCandidates } = await import('../src/atlas-evidence-semantic.mjs')

/** Start an app on an OS-assigned port and return `GET <path> → json`. */
async function serve(...routers) {
  const app = express()
  for (const r of routers) app.use(r)
  const server = await new Promise((res) => {
    const s = app.listen(0, '127.0.0.1', () => res(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const get = async (p) => {
    const r = await fetch(base + p)
    return { status: r.status, body: await r.json() }
  }
  return { get, close: () => new Promise((res) => server.close(res)) }
}

/* --- 1. zero addons: byte-identical -------------------------------------- */

test('with no addons the response shapes are exactly the pre-addon ones', async () => {
  assert.deepEqual(addonList(), [])
  assert.deepEqual(addonScorecardStats(), [])
  assert.equal(addonEvidenceLeg(), null)

  const out = await searchAllLegs('widget')
  assert.ok(!('legs' in out), 'no `legs` key at all — not an empty array')
  assert.deepEqual(Object.keys(out).sort(), ['items', 'limit', 'total', 'truncated'])
  assert.equal(out.items[0].title, 'Widget')

  const app = await serve(readRouter())
  const dash = await app.get('/api/dashboard')
  // The scorecard is the file its own writer left, untouched — no join happened.
  assert.deepEqual(dash.body.scorecard, { generated: '2026-01-01T00:00:00Z', stats: [{ label: 'Core tile', value: '7' }] })
  const search = await app.get('/api/search?q=widget')
  assert.ok(!('legs' in search.body))
  await app.close()

  // …and the evidence seam is inert, with a reason that names the addon.
  assert.deepEqual(subAsks('  a task  '), ['a task'])
  const sem = await semanticCandidates({ asks: ['x'], root: vault, enabled: true })
  assert.equal(sem.available, false)
  assert.match(sem.reason, /semantic-search/)
})

/* --- 2. enablement ------------------------------------------------------- */

test('ATLAS_ADDONS wins over addons.json whenever it is DEFINED, empty included', () => {
  const before = process.env.ATLAS_ADDONS
  try {
    process.env.ATLAS_ADDONS = 'demo, broken ,demo'
    assert.deepEqual(enabledNames(), ['demo', 'broken'], 'trimmed, deduped, order kept')
    process.env.ATLAS_ADDONS = ''
    assert.deepEqual(enabledNames(), [], 'an empty value means NONE, not "fall back to the file"')
    delete process.env.ATLAS_ADDONS
    // No addons.json in this worktree → nothing enabled. (The file is gitignored
    // operator-local config; addons.example.json is the shipped template.)
    assert.deepEqual(enabledNames(), [])
  } finally {
    if (before === undefined) delete process.env.ATLAS_ADDONS
    else process.env.ATLAS_ADDONS = before
  }
})

/* --- 3. loading, isolation, and every hook -------------------------------- */

test('a broken addon is recorded and skipped; a good one registers every hook', async () => {
  process.env.ATLAS_ADDONS = 'demo,broken,../escape,nope'
  const r = await loadAddons()
  assert.deepEqual(r.loaded, ['demo'])

  const errs = addonErrors()
  assert.deepEqual(
    errs.map((e) => e.name),
    ['broken', '../escape', 'nope'],
  )
  assert.match(errs.find((e) => e.name === 'broken').error, /deliberately broken/)
  // A traversal-shaped name is refused on the NAME, before any path is built.
  assert.match(errs.find((e) => e.name === '../escape').error, /invalid addon name/)
  assert.match(errs.find((e) => e.name === 'nope').error, /no such addon directory/)

  const list = addonList()
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'demo')
  assert.deepEqual(list[0].status, { fixture: true })
  assert.deepEqual(list[0].hooks.sort(), ['cron', 'evidenceLeg', 'mcpTools', 'routes', 'scorecardStats', 'searchLeg', 'status'])

  assert.deepEqual(addonCron(), [{ addon: 'demo', schedule: '*/7 * * * *', command: 'echo demo', comment: 'fixture entry' }])
  assert.deepEqual(
    addonMcpTools().map((t) => t.name),
    ['demo_ping'],
  )
})

test('loadAddons is idempotent — a second call does not double-register', async () => {
  await loadAddons()
  assert.equal(addonList().length, 1)
  assert.equal(addonCron().length, 1)
})

/* --- 4. the core surfaces, with an addon loaded --------------------------- */

test('GET /api/addons lists what is enabled and mounts the addon routes', async () => {
  const app = await serve(addonRouter())
  const { body } = await app.get('/api/addons')
  assert.equal(body.addons[0].name, 'demo')
  assert.equal(body.errors.length, 3)
  const ping = await app.get('/api/demo-addon/ping')
  assert.deepEqual(ping.body, { ok: true, name: 'demo', dir: true })
  await app.close()
})

test('an addon search leg is UNIONED into legs[], never merged into items', async () => {
  const out = await searchAllLegs('widget', 5)
  // The built-in full-text ranking is untouched…
  assert.equal(out.items.length, 1)
  assert.equal(out.items[0].title, 'Widget')
  assert.equal(out.total, 1)
  // …and the addon's rows live in their own labelled entry, with their own score.
  assert.equal(out.legs.length, 1)
  const leg = out.legs[0]
  assert.deepEqual({ key: leg.key, label: leg.label, addon: leg.addon, available: leg.available }, { key: 'demo', label: 'Demo leg', addon: 'demo', available: true })
  assert.equal(leg.items.length, 2)
  assert.equal(leg.items[0].title, 'demo:widget:0')
  assert.equal(leg.items[0].similarity, 0.5)
  assert.deepEqual(leg.index, { ageMinutes: 3 })
  // No addon row leaked into `items`.
  assert.ok(!out.items.some((i) => i.title.startsWith('demo:')))
})

test('a leg that throws degrades to available:false with a reason — the full-text leg still answers', async () => {
  const out = await searchAllLegs('__throw__')
  assert.equal(out.legs[0].available, false)
  assert.match(out.legs[0].reason, /encoder exploded/)
  assert.deepEqual(out.legs[0].items, [])
  // The whole point: the built-in leg is not taken down with it. (`__throw__`
  // matches nothing in this vault, so the assertion is on the SHAPE surviving.)
  assert.deepEqual(Object.keys(out).sort(), ['items', 'legs', 'limit', 'total', 'truncated'])
})

test('the scorecard join is additive and happens at READ time', async () => {
  const app = await serve(readRouter())
  const { body } = await app.get('/api/dashboard')
  assert.deepEqual(body.scorecard.stats, [{ label: 'Core tile', value: '7' }, { label: 'Demo tile', value: '1', trend: 'neutral', group: 'Demo addon' }])
  assert.equal(body.scorecard.generated, '2026-01-01T00:00:00Z')
  // 🔴 The raw file endpoint is NOT joined — one writer per file, and
  // data/scorecard.json still reads back exactly what its writer wrote.
  const raw = await app.get('/api/data/scorecard')
  assert.deepEqual(raw.body, { generated: '2026-01-01T00:00:00Z', stats: [{ label: 'Core tile', value: '7' }] })
  await app.close()
})

test('a scorecardStats hook that throws contributes nothing — the card still renders', async () => {
  process.env.DEMO_ADDON_STATS_THROW = '1'
  try {
    assert.deepEqual(addonScorecardStats(), [])
    const app = await serve(readRouter())
    const { status, body } = await app.get('/api/dashboard')
    assert.equal(status, 200)
    // Back to exactly the un-joined file — a broken tile must not 500 the bundle.
    assert.deepEqual(body.scorecard.stats, [{ label: 'Core tile', value: '7' }])
    await app.close()
  } finally {
    delete process.env.DEMO_ADDON_STATS_THROW
  }
})

test('the spawn-evidence seam delegates to the addon and back again', async () => {
  assert.deepEqual(subAsks('anything at all'), ['ask-one', 'ask-two'])
  const sem = await semanticCandidates({ asks: ['x'], root: vault, enabled: true })
  assert.equal(sem.available, true)
  assert.equal(sem.rows[0].text, 'demo passage')
})
