/* ------------------------------------------------------------------ *
 * The index reader and the leg's status reporting (api/semantic.mjs,
 * api/heal.mjs) — everything that can be asserted with NO encoder and NO real
 * index, which is every CI machine.
 *
 * 🔴 THE REGRESSION THIS FILE EXISTS FOR: the vector file is named by
 * `meta.json`, never by a constant here. The indexer PING-PONGS between
 * `vectors.f32` and `vectors.b.f32` so that renaming meta.json is the only
 * commit point, and deletes the one it did not write. A reader that hard-codes
 * `vectors.f32` therefore FLAPS WITH REBUILD PARITY — perfect after an even
 * number of content-changing rebuilds, `available:false, reason: ENOENT` after
 * an odd one — and a leg that is correct half the time is harder to notice, and
 * harder to trust once noticed, than one that is simply down.
 *
 * Also pinned: provenance mismatch is REFUSED rather than served (a vector built
 * from different text than the reader thinks is worse than no vector), and every
 * failure path answers `available: false` with a READABLE reason — "did not run"
 * and "ran and found nothing" are different facts.
 *
 * Run: node --test addons/semantic-search/test/semantic.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// heal.mjs freezes its state-file path at import; pin it first.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-heal-'))
process.env.ATLAS_EMBED_STATE_FILE = path.join(stateDir, 'install.state')
// …and point the encoder at a directory that certainly does not exist, so
// `embedRuntimeAvailable()` is false on a developer box that HAS installed it.
process.env.ATLAS_EMBED_DIR = path.join(stateDir, 'no-encoder-here')

const { loadIndex, indexStatus, semanticStatus, semanticSearch, indexDirFor, INDEX_SUBDIR } = await import('../api/semantic.mjs')
const { MODEL_ID, DIMS } = await import('../api/embed.mjs')
const { CHUNKER_VERSION } = await import('../api/chunk.mjs')
const { healNote, installState } = await import('../api/heal.mjs')

/** A synthetic vault + index. Vectors are unit 2-D vectors padded to DIMS, so
 *  cosine is exact and hand-checkable, and the first component is non-zero —
 *  the reader treats an all-zero lead as an unwritten slot. */
function makeIndex({ vectorsFile = 'vectors.f32', model = MODEL_ID, dims = DIMS, chunkerVersion = CHUNKER_VERSION, angles = [0, 0.4, 0.9], truncate = false } = {}) {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-index-'))
  const dir = path.join(vaultPath, INDEX_SUBDIR)
  fs.mkdirSync(dir, { recursive: true })
  const rows = angles.map((_, i) => {
    const body = `# Page ${i}\n\nthe body of page ${i}\n`
    fs.mkdirSync(path.join(vaultPath, 'Wiki'), { recursive: true })
    fs.writeFileSync(path.join(vaultPath, 'Wiki', `P${i}.md`), body)
    const stripped = body
    const start = stripped.indexOf('the body')
    return { path: `Wiki/P${i}.md`, title: `Page ${i}`, crumb: `Page ${i}`, hash: `h${i}`, start, end: stripped.length - 1 }
  })
  const vecs = new Float32Array(rows.length * dims)
  angles.forEach((a, i) => {
    vecs[i * dims] = Math.cos(a)
    vecs[i * dims + 1] = Math.sin(a)
  })
  const buf = Buffer.from(vecs.buffer)
  fs.writeFileSync(path.join(dir, vectorsFile), truncate ? buf.subarray(0, buf.length - dims * 4) : buf)
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ vault: 'atlas', vaultPath, vaultSha: 'abc1234', builtAt: '2026-03-04T10:00:00Z', model, dtype: 'fp16', dims, chunkerVersion, vectorsFile, pages: rows.length, rows }),
  )
  return { vaultPath, dir }
}

test('the vector file is read by the name meta.json gives it — both parities', () => {
  for (const name of ['vectors.f32', 'vectors.b.f32']) {
    const { vaultPath } = makeIndex({ vectorsFile: name })
    const idx = loadIndex(vaultPath)
    assert.equal(idx.error, undefined, `an index whose live file is ${name} must load`)
    assert.equal(idx.meta.vectorsFile, name)
    assert.deepEqual(idx.live, [0, 1, 2])
    assert.equal(indexStatus(vaultPath).ok, true)
  }
})

test('an index built by a different encoder or chunker is REFUSED, and says which', () => {
  for (const [patch, re] of [
    [{ model: 'some-other/model' }, /provenance mismatch \(model some-other\/model/],
    [{ chunkerVersion: CHUNKER_VERSION + 1 }, /chunker/],
  ]) {
    const { vaultPath } = makeIndex(patch)
    const st = indexStatus(vaultPath)
    assert.equal(st.ok, false)
    assert.match(st.reason, re)
  }
})

test('a vector file shorter than the row table is refused, not read past its end', () => {
  const { vaultPath } = makeIndex({ truncate: true })
  assert.match(loadIndex(vaultPath).error, /shorter than meta\.rows/)
})

test('no index at all is a readable reason that names the fix', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-noindex-'))
  assert.match(loadIndex(empty).error, /no index/)
  assert.match(semanticStatus(empty).reason, /scripts\/index\.mjs/)
})

test('provenance separates "content changed" from "a sweep confirmed it"', () => {
  const { vaultPath, dir } = makeIndex()
  const before = indexStatus(vaultPath).index
  assert.equal(before.sweptAt, null)
  assert.equal(before.chunks, 3)
  assert.equal(before.builtAt, '2026-03-04T10:00:00Z')
  // A sweep that changed nothing still moves `sweptAt`, and `ageMinutes` follows
  // IT — an index built two days ago and swept two minutes ago is CURRENT.
  fs.writeFileSync(path.join(dir, 'sweep.json'), JSON.stringify({ sweptAt: new Date().toISOString(), vaultSha: 'def', chunks: 3 }))
  // Touch meta.json so the mtime cache reloads.
  const now = new Date()
  fs.utimesSync(path.join(dir, 'meta.json'), now, now)
  const after = indexStatus(vaultPath).index
  assert.equal(after.builtAt, '2026-03-04T10:00:00Z', 'builtAt must not move when nothing was rebuilt')
  assert.ok(after.ageMinutes <= 1, 'ageMinutes reads off sweptAt, not builtAt')
  assert.equal(after.vaultSha, 'def')
})

test('a usable index with no encoder still degrades — and SAYS what is being done about it', async () => {
  const { vaultPath } = makeIndex()
  const st = semanticStatus(vaultPath)
  assert.equal(st.available, false)
  assert.match(st.reason, /encoder not installed/)
  assert.match(st.reason, /scheduled sweep reinstalls it/, 'a missing encoder must name the self-heal, not just the absence')

  // …and the leg itself never throws into the route.
  const out = await semanticSearch({ q: 'anything', limit: 5, vaultPath })
  assert.equal(out.available, false)
  assert.deepEqual(out.items, [])
  assert.match(out.reason, /encoder not installed/)
})

test('ATLAS_SEMANTIC=0 is a kill switch that keeps the addon enabled', async () => {
  const before = process.env.ATLAS_SEMANTIC
  process.env.ATLAS_SEMANTIC = '0'
  try {
    // Read at import, so a fresh module instance is what the switch governs.
    const mod = await import(`../api/semantic.mjs?kill=${Date.now()}`)
    assert.equal(mod.SEMANTIC_ENABLED, false)
    assert.match(mod.semanticStatus(makeIndex().vaultPath).reason, /ATLAS_SEMANTIC=0/)
  } finally {
    if (before === undefined) delete process.env.ATLAS_SEMANTIC
    else process.env.ATLAS_SEMANTIC = before
  }
})

test('the self-heal note distinguishes four situations a bare absence flattens into one', () => {
  const now = Date.parse('2026-03-04T12:00:00Z')
  assert.match(healNote({}, now), /scheduled sweep reinstalls it/)
  assert.match(healNote({ phase: 'running', started: String(now / 1000 - 60) }, now), /reinstall is running now/)
  assert.match(healNote({ phase: 'running', started: String(now / 1000 - 60 * 60 * 6) }, now), /never reported back/)
  assert.match(healNote({ phase: 'failed', failures: '3', reason: 'no network' }, now), /3 failed reinstall attempts: no network/)

  const off = process.env.ATLAS_EMBED_AUTOINSTALL
  process.env.ATLAS_EMBED_AUTOINSTALL = '0'
  try {
    assert.match(healNote({ phase: 'failed', failures: '3' }, now), /auto-reinstall is off/)
  } finally {
    if (off === undefined) delete process.env.ATLAS_EMBED_AUTOINSTALL
    else process.env.ATLAS_EMBED_AUTOINSTALL = off
  }
})

test('installState parses the installer’s key=value lines, and an absent file is {}', () => {
  assert.deepEqual(installState(), {})
  fs.writeFileSync(process.env.ATLAS_EMBED_STATE_FILE, 'phase=failed\nfailures=2\nlast=1772000000\nreason=curl: (28) timeout=after 30s\n')
  assert.deepEqual(installState(), { phase: 'failed', failures: '2', last: '1772000000', reason: 'curl: (28) timeout=after 30s' })
})

test('indexDirFor keeps vectors in the vault’s machine-owned data/ layer', () => {
  assert.equal(indexDirFor('/some/vault'), path.join('/some/vault', 'data', 'atlas-index'))
  assert.ok(!INDEX_SUBDIR.startsWith('Wiki'), 'vectors must never land in Wiki/ or Tasks/')
})
