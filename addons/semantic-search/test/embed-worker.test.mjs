/* ------------------------------------------------------------------ *
 * THE ENCODER WORKER — the four properties that decide whether moving this
 * addon's retrieval off the API's main thread fixed the hazard or moved it.
 *
 * The hazard: both legs are CPU-bound and used to run ON the Express event loop,
 * so while one computed the API answered nothing at all — including the health
 * probe a watchdog reads to decide the process is dead, and including the
 * keep-alive socket an agent spawn is waiting on. And the legs' own rescue
 * deadlines could not fire while it happened: a blocked loop cannot run its own
 * timer.
 *
 *   1. THE LOOP STAYS RESPONSIVE while the encoder computes. Measured here by
 *      sampling a timer's lag during the work. The inline arm is asserted too —
 *      a responsiveness test that cannot SEE the old behaviour is not a
 *      regression test, it is a tautology.
 *   2. EVERY FAILURE DEGRADES, none propagates. A worker that crashes, exits or
 *      never answers must yield `available:false` + a reason and a keyword-only
 *      block. A spawn must never fail because of the semantic leg — that is the
 *      pre-existing contract and the whole reason the leg is an addon.
 *   3. THE DEADLINE FIRES. It is the property that did not exist before and the
 *      one thing the move buys beyond latency, so it is asserted end to end
 *      through `semanticCandidates`, not on the timer in isolation.
 *   4. ONE WORKER, ONE ENCODER COPY, shared by every call site. The model is
 *      ~660 MB; a second copy is not a performance regression, it is an OOM.
 *
 * Hermetic: no ONNX runtime, no weights, no real vault — which is the state of
 * every CI runner and, deliberately, the state this file leans on. The client's
 * lifecycle is driven against a stub worker (`fixtures/encoder-worker-stub.mjs`);
 * the REAL worker is exercised through the degradation path, with
 * `ATLAS_EMBED_DIR` pointed at a directory that looks installed and is not, so
 * the round trip is genuine and the model load is not.
 *
 * Run: node --test addons/semantic-search/test/embed-worker.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* An encoder that LOOKS installed: `embedRuntimeAvailable()` is two existsSync
 * checks, so the leg gets past its cheap gate, spawns the worker and fails where
 * the model is actually loaded — inside the worker, which is the path under
 * test. Set before the first import: ATLAS_EMBED_DIR is read at module load, and
 * a Worker gets a COPY of process.env taken when it is constructed. */
const FAKE_EMBED = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-fake-embed-'))
fs.mkdirSync(path.join(FAKE_EMBED, 'node_modules', '@huggingface', 'transformers'), { recursive: true })
process.env.ATLAS_EMBED_DIR = FAKE_EMBED
process.env.AGENT_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-embw-local-'))
process.env.ATLAS_EMBED_STATE_FILE = path.join(FAKE_EMBED, 'install.state')

const { createEncoderClient, sharedEncoderClient, encoderWorkerEnabled, encoderState } = await import('../api/embed-client.mjs')
const { MODEL_ID, DIMS } = await import('../api/embed.mjs')
const { CHUNKER_VERSION } = await import('../api/chunk.mjs')
const { indexDirFor, semanticStatus, semanticSearch } = await import('../api/semantic.mjs')
const { semanticCandidates } = await import('../api/evidence.mjs')

fs.mkdirSync(path.join(FAKE_EMBED, 'models', MODEL_ID, 'onnx'), { recursive: true })

const STUB = new URL('./fixtures/encoder-worker-stub.mjs', import.meta.url)

/** A miniature vault with a usable-looking index: one page, one row, one
 * (all-ones, never read) vector. Enough for `semanticStatus` to say "yes". */
function tempVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-embw-vault-'))
  fs.mkdirSync(path.join(dir, 'Wiki', 'Concepts'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'Wiki', 'Concepts', 'Widget.md'), '# Widget\n\nOne paragraph about the part.\n')
  const out = indexDirFor(dir)
  fs.mkdirSync(out, { recursive: true })
  const rows = [{ path: path.join('Wiki', 'Concepts', 'Widget.md'), title: 'Widget', crumb: 'Widget', hash: 'deadbeef', start: 0, end: 30 }]
  fs.writeFileSync(path.join(out, 'vectors.f32'), Buffer.alloc(rows.length * DIMS * 4, 1))
  fs.writeFileSync(
    path.join(out, 'meta.json'),
    JSON.stringify({ model: MODEL_ID, dims: DIMS, dtype: 'fp16', chunkerVersion: CHUNKER_VERSION, builtAt: new Date().toISOString(), vaultSha: 'abc123', pages: 1, rows, vectorsFile: 'vectors.f32' }),
  )
  return dir
}

/* --- 1. the loop stays responsive ----------------------------------- */

/** Timer lag sampled every 20 ms while `fn` runs — the in-process equivalent of
 * probing the API from outside, and the same question: how long does a trivial
 * piece of work wait for the loop? */
async function timerLag(fn) {
  const lags = []
  let last = Date.now()
  const t = setInterval(() => {
    const now = Date.now()
    lags.push(Math.max(0, now - last - 20))
    last = now
  }, 20)
  try {
    await fn()
    // Let the delayed tick land, or a blocked arm records no sample at all and
    // reads as the fastest of the two.
    await new Promise((r) => setTimeout(r, 60))
  } finally {
    clearInterval(t)
  }
  lags.sort((a, b) => a - b)
  return { n: lags.length, p95: lags[Math.floor(lags.length * 0.95)] ?? 0, max: lags[lags.length - 1] ?? 0 }
}

test('a CPU-bound retrieval on the worker leaves the event loop free — and the same work inline does not', async (t) => {
  const BURN_MS = 1200
  const c = createEncoderClient(STUB)
  t.after(() => c.stop())
  const off = await timerLag(() => c.call('burn', { ms: BURN_MS }))
  const inline = await timerLag(async () => {
    const until = Date.now() + BURN_MS
    while (Date.now() < until) {}
  })

  // The instrument first: if the inline arm looks healthy, the numbers below
  // mean nothing and this test is not measuring what it claims to.
  assert.ok(inline.max > BURN_MS / 2, `the inline arm must reproduce the stall this exists to fix (max ${inline.max} ms)`)
  assert.ok(off.n > 20, `the loop kept running during the worker arm (only ${off.n} samples)`)
  assert.ok(off.p95 < 150, `p95 loop lag during off-thread retrieval was ${off.p95} ms — the loop is not free`)
  assert.ok(off.max < 400, `worst loop lag during off-thread retrieval was ${off.max} ms (inline: ${inline.max} ms)`)
})

/* --- 2. every failure degrades -------------------------------------- */

test('a worker that crashes mid-call answers the in-flight caller and the NEXT call gets a fresh worker', async (t) => {
  const c = createEncoderClient(STUB)
  t.after(() => c.stop())
  const first = await c.call('echo', { hello: 1 })
  const r = await c.call('crash', {})
  assert.equal(r.ok, false)
  assert.match(r.reason, /encoder worker error/, 'the reason must name the failure — a spawn logs it as semanticReason')
  const after = await c.call('echo', { hello: 2 })
  assert.equal(after.ok, true, 'a crash degrades ONE retrieval, it does not disable the leg for the process')
  assert.notEqual(after.value.threadId, first.value.threadId, 'the replacement is a new thread')
  assert.equal(c.spawned(), 2, 'exactly one respawn')
})

test('a worker that exits mid-call is reported as an exit, not as an empty result', async (t) => {
  const c = createEncoderClient(STUB)
  t.after(() => c.stop())
  const r = await c.call('exit', {})
  assert.equal(r.ok, false)
  assert.match(r.reason, /exited \(code 7\)/, '"the encoder died" must never be indistinguishable from "the vault had nothing"')
})

test('the real worker refuses an unknown op BY NAME rather than answering nothing', async (t) => {
  const c = createEncoderClient()
  t.after(() => c.stop())
  const r = await c.call('definitely-not-an-op', {})
  assert.equal(r.ok, false)
  assert.match(r.reason, /unknown encoder op definitely-not-an-op/)
})

/* --- 3. the deadline fires ------------------------------------------ *
 * ⚠️ FIRST OF THE REAL-WORKER TESTS ON PURPOSE. Nothing has started the shared
 * worker yet, so this retrieval pays the thread start and a 1 ms budget wins by
 * orders of magnitude. Run after the worker is warm, the degraded reply comes
 * back inside the same millisecond and the race is a coin toss. */

test('a retrieval that overruns its deadline yields the keyword-only block, and the next one still works', async () => {
  const dir = tempVault()
  try {
    const r = await semanticCandidates({ asks: ['anything at all'], root: dir, enabled: true, deadlineMs: 1 })
    assert.equal(r.available, false)
    assert.equal(r.reason, 'semantic leg exceeded 1 ms', 'the existing reason vocabulary — audit lines are grepped, not parsed')
    assert.deepEqual(r.rows, [])
    // The abandoned request's late reply must be dropped silently rather than
    // resolving somebody else's call.
    const again = await semanticCandidates({ asks: ['anything at all'], root: dir, enabled: true })
    assert.equal(again.available, false)
    assert.match(again.reason, /not installed/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/* --- 2, continued: failure degrades on the real worker too ---------- */

test('a missing encoder degrades to a keyword-only block, through the real worker', async () => {
  const dir = tempVault()
  try {
    assert.equal(semanticStatus(dir).available, true, 'the cheap gate must pass, or the worker is never reached and this tests nothing')
    const r = await semanticCandidates({ asks: ['does the eight-megabyte part need octal SPI?'], root: dir, enabled: true })
    assert.equal(r.available, false)
    assert.deepEqual(r.rows, [])
    assert.match(r.reason, /not installed/, 'the reason has to survive the thread boundary — it is what audit.log records')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a call that never comes back is abandoned by its caller, not by the client, and does not wedge the next one', async (t) => {
  // ⚠️ `stop()` is not tidiness here: the abandoned request is still OWED, so the
  // client keeps the worker referenced and this process would never exit.
  const c = createEncoderClient(STUB)
  t.after(() => c.stop())
  const hung = c.call('hang', {})
  const raced = await Promise.race([hung, new Promise((r) => setTimeout(() => r('deadline'), 80))])
  assert.equal(raced, 'deadline')
  const after = await c.call('echo', { after: true })
  assert.equal(after.ok, true, 'the worker is serial, not broken — a wedged request must not poison the queue')
  assert.equal(c.spawned(), 1, 'and it is still the same worker')
})

/* --- 4. one worker, one encoder copy -------------------------------- */

test('both semantic call sites share ONE worker — a second copy of a 660 MB model is an OOM, not a slowdown', async () => {
  const dir = tempVault()
  try {
    assert.equal(encoderWorkerEnabled(), true, 'the API process must be running the worker path by default')
    // `/api/search`'s leg and the spawn-evidence leg, concurrently — the exact
    // shape that would race two model loads into the heap if they did not share.
    await Promise.all([semanticSearch({ q: 'widget octal spi', limit: 5, vaultPath: dir }), semanticCandidates({ asks: ['widget octal spi'], root: dir, enabled: true })])
    // ONE, counted from the process start: every real-path call in this file —
    // both legs, concurrent and sequential — has been answered by the same
    // worker, which is what "one encoder copy" means operationally.
    assert.equal(sharedEncoderClient().spawned(), 1, 'a semantic call site started a second worker, i.e. a second ~660 MB model')
    assert.equal(sharedEncoderClient().running(), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrent calls are answered by the same thread, and each reply says how long it queued behind the others', async (t) => {
  const c = createEncoderClient(STUB)
  t.after(() => c.stop())
  const rs = await Promise.all([c.call('burn', { ms: 60 }), c.call('burn', { ms: 60 }), c.call('burn', { ms: 60 })])
  assert.equal(new Set(rs.map((r) => r.value.threadId)).size, 1, 'one worker answered all three')
  assert.equal(c.spawned(), 1)
  assert.ok(
    rs.some((r) => r.queueMs >= 40),
    'the encoder is serial by design, so waiting behind another retrieval must be visible (semanticQueueMs) rather than read as a slow embed',
  )
})

/* --- the mirrored model state --------------------------------------- */

test('the encoder state a caller reads is the worker`s, and an unsolicited announcement updates it', async (t) => {
  // Without this the query budget would be chosen from a state that stops
  // changing after the first reply: an idle eviction inside the worker would be
  // invisible and the next cold load would be judged against the warm budget.
  const c = createEncoderClient(STUB)
  t.after(() => c.stop())
  assert.equal(c.state().loaded, false, 'nothing is loaded until something loads it')
  await c.call('announce', { loaded: true, loading: false, loadedAt: '2026-08-15T00:00:00.000Z', lastLoadMs: 2100, idleEvictMs: 0 })
  assert.equal(c.state().loaded, true)
  assert.equal(c.state().lastLoadMs, 2100)
  // And with no worker at all, the shape is still the five fields residentState()
  // returns — a consumer must not be able to tell which side answered.
  assert.deepEqual(Object.keys(encoderState()).sort(), ['idleEvictMs', 'lastLoadMs', 'loaded', 'loadedAt', 'loading'])
})
