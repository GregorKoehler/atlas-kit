/* ------------------------------------------------------------------ *
 * The semantic-index sweep's run safety (scripts/index.mjs).
 *
 * Measured in the field: a bulk vault commit made one sweep run for over an hour
 * and nothing stopped the next five-minute ticks starting beside it — up to 5 at
 * ~900 MB each. They picked their target from the live name at START, truncated
 * each other's files and unlinked the file meta.json named by then; `previous()`
 * swallowed the failure as "first build", an aborted run committed anyway, and
 * 18 % of rows held a vector while the scorecard said every chunk was indexed.
 * None of it failed anywhere a person would look.
 *
 * So the script runs here for real, as child processes: a lock, a SIGKILL and a
 * race cannot be tested in-process. The runtime is a STUB installed where
 * `load()` looks for the real one, so production code paths run unmodified, with
 * no encoder and no test hook in the script. The gate below is what makes each
 * overlap deterministic rather than a matter of timing.
 *
 * Run: node --test addons/semantic-search/test/index-sweep.test.mjs
 * ------------------------------------------------------------------ */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { MODEL_ID, DIMS } from '../api/embed.mjs'
import { sweepStats, readSweep, countFilled } from '../api/sweep.mjs'
import { indexStatus, semanticSearch } from '../api/semantic.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, '..', 'scripts', 'index.mjs')

/* --- the stub runtime ---------------------------------------------------- *
 * Vectors are a deterministic function of the text, so a row can be checked
 * against what it should hold. STUB_GATE parks a run after it has opened its target
 * (`<gate>.started` appears) until `<gate>.go` exists; STUB_FAIL_AFTER aborts after
 * N embeds through the same throw the memory floor uses. */
const STUB = `
import fs from 'node:fs'
import crypto from 'node:crypto'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let calls = 0
export const env = {}
export const AutoTokenizer = { from_pretrained: async () => async (texts) => ({ texts, attention_mask: { data: [1n] } }) }
export const AutoModel = {
  from_pretrained: async () => async ({ texts }) => {
    const gate = process.env.STUB_GATE
    if (gate) {
      fs.writeFileSync(gate + '.started', '')
      while (!fs.existsSync(gate + '.go')) await sleep(10)
    }
    if (process.env.STUB_FAIL_AFTER && calls >= Number(process.env.STUB_FAIL_AFTER)) throw new Error('ABORTED on memory headroom: stub')
    calls++
    const data = new Float32Array(texts.length * 768)
    texts.forEach((t, i) => {
      const seed = crypto.createHash('sha1').update(t).digest().readUInt16LE(0)
      for (let j = 0; j < 768; j++) data[i * 768 + j] = 1 + ((seed + j) % 97)
    })
    return { sentence_embedding: { dims: [texts.length, 768], data } }
  },
}
`
const RUNTIME = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sweep-runtime-'))
const STUB_ENV = {
  ATLAS_EMBED_MODULE_DIR: path.join(RUNTIME, 'node_modules'),
  ATLAS_EMBED_MODEL_DIR: path.join(RUNTIME, 'models'),
  // Never let a busy box turn a test into the pre-flight's clean skip.
  ATLAS_INDEX_MIN_AVAIL_MB: '1',
}
before(() => {
  const dist = path.join(STUB_ENV.ATLAS_EMBED_MODULE_DIR, '@huggingface', 'transformers', 'dist')
  fs.mkdirSync(dist, { recursive: true })
  fs.writeFileSync(path.join(dist, 'transformers.node.mjs'), STUB)
  fs.mkdirSync(path.join(STUB_ENV.ATLAS_EMBED_MODEL_DIR, MODEL_ID, 'onnx'), { recursive: true })
  // Read per call by embedRuntimeAvailable()/load(), for the in-process readers.
  Object.assign(process.env, STUB_ENV)
})
const dirs = [RUNTIME]
const children = []
// A test that fails while a run is parked at its gate must not hang the file.
after(() => {
  children.forEach((c) => c.kill('SIGKILL'))
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }))
})

/* --- helpers ------------------------------------------------------------- */
const PAGES = 6
function tempVault(pages = PAGES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sweep-vault-'))
  dirs.push(dir)
  for (let i = 0; i < pages; i++) addPage(dir, i)
  return dir
}
function addPage(dir, i) {
  fs.mkdirSync(path.join(dir, 'Wiki'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'Wiki', `page-${i}.md`), `# Page ${i}\n\n${`Body sentence number ${i} long enough to stand alone as a chunk. `.repeat(10)}\n`)
}
const idx = (vault) => path.join(vault, 'data', 'atlas-index')
const metaOf = (vault) => JSON.parse(fs.readFileSync(path.join(idx(vault), 'meta.json'), 'utf-8'))
const namedFile = (vault) => path.join(idx(vault), metaOf(vault).vectorsFile || 'vectors.f32')
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex')
/** Every file in the index dir → content hash + mtime: "touched nothing" stated literally. */
const snapshot = (vault) => Object.fromEntries(fs.readdirSync(idx(vault)).sort().map((f) => [f, `${sha(path.join(idx(vault), f))} ${fs.statSync(path.join(idx(vault), f)).mtimeMs}`]))
const indexBytes = (vault) => ({ meta: sha(path.join(idx(vault), 'meta.json')), vectors: sha(namedFile(vault)) })

function runSync(vault, { args = [], env = {} } = {}) {
  return spawnSync(process.execPath, [SCRIPT, '--path', vault, ...args], { encoding: 'utf-8', env: { ...process.env, ...STUB_ENV, ...env } })
}
/** A run parked at the gate, once it has opened its target and holds the lock. */
async function gatedRun(vault, tag, { args = [] } = {}) {
  const gate = path.join(idx(vault), '..', `gate-${tag}`)
  const child = spawn(process.execPath, [SCRIPT, '--path', vault, ...args], { stdio: 'ignore', env: { ...process.env, ...STUB_ENV, STUB_GATE: gate } })
  children.push(child)
  const closed = new Promise((res) => child.on('close', (code, signal) => res({ code, signal })))
  const deadline = Date.now() + 30000
  while (!fs.existsSync(gate + '.started')) {
    if (Date.now() > deadline) throw new Error(`run ${tag} never reached the gate`)
    await new Promise((r) => setTimeout(r, 10))
  }
  return { child, closed, release: () => fs.writeFileSync(gate + '.go', '') }
}
/** The invariant under test: whatever meta.json names, right now, exists and is whole. */
function assertMetaWhole(vault) {
  const m = metaOf(vault)
  const f = path.join(idx(vault), m.vectorsFile || 'vectors.f32')
  assert.ok(fs.existsSync(f), `meta.json names a missing file: ${m.vectorsFile}`)
  assert.equal(fs.statSync(f).size, m.rows.length * DIMS * 4)
  assert.equal(countFilled(f, m.rows.length, DIMS), m.rows.length)
}
const tile = (stats, label) => stats.find((s) => s.label === label)
/** What an index built by the previous indexer looks like: no `filled`, a legacy file name. */
function toLegacyIndex(vault) {
  const m = metaOf(vault)
  fs.renameSync(namedFile(vault), path.join(idx(vault), 'vectors.b.f32'))
  m.vectorsFile = 'vectors.b.f32'
  delete m.filled
  fs.writeFileSync(path.join(idx(vault), 'meta.json'), JSON.stringify(m))
}

/* --- 1. single flight ---------------------------------------------------- */

test('a second run while one is in flight exits clean and touches nothing', async () => {
  const vault = tempVault()
  assert.equal(runSync(vault).status, 0)
  addPage(vault, 100)
  const first = await gatedRun(vault, 'a')
  const before = snapshot(vault)
  const second = runSync(vault)
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /another sweep holds/)
  assert.deepEqual(snapshot(vault), before)
  first.release()
  assert.equal((await first.closed).code, 0)
  assertMetaWhole(vault)
})

test('a run killed with SIGKILL frees the lock, and the next run clears its leftover', async () => {
  const vault = tempVault()
  const holder = await gatedRun(vault, 'a')
  const leftover = fs.readdirSync(idx(vault)).filter((f) => f.endsWith('.f32'))
  assert.equal(leftover.length, 1)
  holder.child.kill('SIGKILL')
  assert.equal((await holder.closed).signal, 'SIGKILL')
  const next = runSync(vault)
  assert.equal(next.status, 0, next.stderr)
  assert.doesNotMatch(next.stdout, /another sweep holds/)
  assertMetaWhole(vault)
  assert.deepEqual(fs.readdirSync(idx(vault)).filter((f) => f.endsWith('.f32')), [metaOf(vault).vectorsFile])
})

test('a no-op sweep writes nothing but the sweep stamp', () => {
  const vault = tempVault()
  assert.equal(runSync(vault).status, 0)
  const bytes = indexBytes(vault)
  const noop = runSync(vault)
  assert.equal(noop.status, 0)
  assert.match(noop.stdout, /unchanged/)
  assert.deepEqual(indexBytes(vault), bytes)
})

/* --- 2. the race, with the lock out of the way ---------------------------- *
 * Deleting the lock file is the real way to bypass it: the second run gets a new
 * inode and a free lock. Needs no test-only switch in the script. */
for (const [name, firstDone] of [
  ['the older run commits first', 'older'],
  ['the newer run commits first', 'newer'],
]) {
  test(`overlap without the lock: meta.json never names a missing file (${name})`, async () => {
    const vault = tempVault()
    assert.equal(runSync(vault).status, 0)
    addPage(vault, 100)
    const older = await gatedRun(vault, 'older')
    fs.rmSync(path.join(idx(vault), 'sweep.lock'))
    const newer = await gatedRun(vault, 'newer')

    const watch = setInterval(() => assertMetaWhole(vault), 1)
    try {
      const [a, b] = firstDone === 'older' ? [older, newer] : [newer, older]
      a.release()
      assert.equal((await a.closed).code, 0)
      assertMetaWhole(vault)
      // The first commit must have left the other live run's target alone.
      b.release()
      assert.equal((await b.closed).code, 0)
      assertMetaWhole(vault)
    } finally {
      clearInterval(watch)
    }
    // Nothing but the live file survives, and a later sweep reuses all of it.
    const again = runSync(vault)
    assert.equal(again.status, 0)
    assert.match(again.stdout, /unchanged/)
  })
}

/* --- 3. a partial may not regress ----------------------------------------- */

test('an aborted run with fewer filled rows leaves the live index byte-identical', () => {
  const vault = tempVault()
  assert.equal(runSync(vault).status, 0)
  const bytes = indexBytes(vault)
  const swept = readSweep(idx(vault)).sweptAt
  const total = metaOf(vault).rows.length

  const run = runSync(vault, { args: ['--full'], env: { STUB_FAIL_AFTER: '1' } })
  assert.equal(run.status, 3)
  assert.match(run.stderr, /DISCARDED/)
  assert.deepEqual(indexBytes(vault), bytes)
  // Its target is gone too: a discarded run leaves no 40 MB behind.
  assert.deepEqual(fs.readdirSync(idx(vault)).filter((f) => f.endsWith('.f32')), [metaOf(vault).vectorsFile])

  const s = readSweep(idx(vault))
  assert.equal(s.sweptAt, swept, 'an aborted run confirmed nothing, so it may not stamp sweptAt')
  assert.equal(s.filled, total)
  assert.equal(s.chunks, total)
  assert.match(s.aborted.reason, /memory headroom/)
  assert.equal(s.abortedToday, 1)
})

test('an aborted run holding at least as many rows commits, and a cold build resumes across aborts', () => {
  const vault = tempVault()
  const first = runSync(vault, { env: { STUB_FAIL_AFTER: '2' } })
  assert.equal(first.status, 3)
  assert.equal(metaOf(vault).filled, 2)
  assert.equal(countFilled(namedFile(vault), metaOf(vault).rows.length, DIMS), 2)
  const again = runSync(vault, { env: { STUB_FAIL_AFTER: '1' } })
  assert.equal(again.status, 3)
  assert.equal(metaOf(vault).filled, 3)
  const done = runSync(vault)
  assert.equal(done.status, 0)
  assertMetaWhole(vault)
  assert.equal(metaOf(vault).aborted, null)
  assert.equal(readSweep(idx(vault)).aborted, null, 'a run that finishes clears the state')
})

test('a partial is compared with a live index built by the previous indexer, which has no `filled`', () => {
  const vault = tempVault()
  assert.equal(runSync(vault).status, 0)
  toLegacyIndex(vault)
  const bytes = indexBytes(vault)
  const run = runSync(vault, { args: ['--full'], env: { STUB_FAIL_AFTER: '1' } })
  assert.equal(run.status, 3)
  assert.deepEqual(indexBytes(vault), bytes)
})

test('an index built by the previous indexer is reused by hash, and its legacy files retire on the next commit', () => {
  const vault = tempVault()
  assert.equal(runSync(vault).status, 0)
  const total = metaOf(vault).rows.length
  toLegacyIndex(vault)
  // A second legacy leftover, as a ping-pong index leaves behind.
  fs.writeFileSync(path.join(idx(vault), 'vectors.f32'), 'stale')

  const noop = runSync(vault)
  assert.match(noop.stdout, /unchanged/)
  assert.equal(readSweep(idx(vault)).filled, total, 'a no-op confirms a full index without rewriting it')

  addPage(vault, 100)
  const delta = runSync(vault)
  assert.equal(delta.status, 0, delta.stderr)
  assert.match(delta.stdout, new RegExp(`reuse ${total} · embed 1 `))
  assertMetaWhole(vault)
  assert.equal(metaOf(vault).filled, total + 1)
  assert.deepEqual(fs.readdirSync(idx(vault)).filter((f) => f.endsWith('.f32')), [metaOf(vault).vectorsFile])
})

/* --- 4. a live index it cannot read is not a first build ------------------ */

for (const [name, damage] of [
  ['the file meta.json names is missing', (v) => fs.rmSync(namedFile(v))],
  ['the file meta.json names is truncated', (v) => fs.truncateSync(namedFile(v), DIMS * 4)],
  ['meta.json is corrupt', (v) => fs.writeFileSync(path.join(idx(v), 'meta.json'), '{"rows":[')],
]) {
  test(`${name}: loud, nothing rewritten, and no re-embed from zero`, () => {
    const vault = tempVault()
    assert.equal(runSync(vault).status, 0)
    const swept = readSweep(idx(vault)).sweptAt
    damage(vault)
    const files = fs.readdirSync(idx(vault)).filter((f) => f !== 'sweep.json')
    const metaBefore = sha(path.join(idx(vault), 'meta.json'))

    const run = runSync(vault)
    assert.equal(run.status, 4)
    assert.match(run.stderr, /live index unreadable/)
    assert.doesNotMatch(run.stdout, /model load/, 'must not start a re-embed')
    assert.deepEqual(fs.readdirSync(idx(vault)).filter((f) => f !== 'sweep.json'), files)
    assert.equal(sha(path.join(idx(vault), 'meta.json')), metaBefore)

    const s = readSweep(idx(vault))
    assert.equal(s.sweptAt, swept)
    assert.match(s.aborted.reason, /live index unreadable/)
    assert.equal(tile(sweepStats(s), 'Last run').value, 'aborted')

    // The decision that heals it.
    assert.equal(runSync(vault, { args: ['--full'] }).status, 0)
    assertMetaWhole(vault)
  })
}

test('no meta.json at all IS a first build, and says nothing alarming', () => {
  const vault = tempVault()
  const run = runSync(vault)
  assert.equal(run.status, 0)
  assert.doesNotMatch(run.stderr, /unreadable/)
})

/* --- 5. honest status ------------------------------------------------------ */

test('the chip and semanticIndex both show filled, total and aborted for a partial index', async () => {
  const vault = tempVault()
  assert.equal(runSync(vault, { env: { STUB_FAIL_AFTER: '2' } }).status, 3)
  const total = metaOf(vault).rows.length
  assert.ok(total > 2)

  const stats = sweepStats(readSweep(idx(vault)))
  assert.equal(tile(stats, 'Chunks indexed').value, `2 of ${total}`)
  assert.equal(tile(stats, 'Chunks indexed').trend, 'down')
  assert.equal(tile(stats, 'Last run').value, 'aborted')
  assert.equal(tile(stats, 'Last run').trend, 'down')
  // It aborted before any sweep finished: never confirmed, and not silent either.
  assert.equal(tile(stats, 'Last swept').value, 'never')

  const { available, index } = await semanticSearch({ q: '', limit: 5, vaultPath: vault })
  assert.equal(available, true)
  assert.equal(index.filled, 2)
  assert.equal(index.chunks, total)
  assert.match(index.aborted.reason, /memory headroom/)
})

test('a healthy index reads full, with no aborted tile and `aborted: null`', () => {
  const vault = tempVault()
  assert.equal(runSync(vault).status, 0)
  const total = metaOf(vault).rows.length
  const stats = sweepStats(readSweep(idx(vault)))
  assert.equal(tile(stats, 'Chunks indexed').value, `${total} of ${total}`)
  assert.equal(tile(stats, 'Chunks indexed').trend, 'neutral')
  assert.equal(tile(stats, 'Last run'), undefined)
  const { index } = indexStatus(vault)
  assert.equal(index.filled, total)
  assert.equal(index.aborted, null)
})

test('an index built by the previous indexer is read, and its holes are counted, so it cannot pass for full', () => {
  const vault = tempVault()
  assert.equal(runSync(vault, { env: { STUB_FAIL_AFTER: '2' } }).status, 3)
  const total = metaOf(vault).rows.length
  toLegacyIndex(vault)
  const { ok, index } = indexStatus(vault)
  assert.equal(ok, true)
  assert.equal(index.filled, 2)
  assert.equal(index.chunks, total)
  assert.match(index.aborted.reason, /memory headroom/, 'a legacy meta.json carries its own abort')
})
