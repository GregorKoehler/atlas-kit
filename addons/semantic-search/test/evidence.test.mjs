/* ------------------------------------------------------------------ *
 * The spawn-evidence dense leg (api/evidence.mjs) — decomposition and the scan,
 * both asserted with NO encoder: `scan()` takes query vectors DIRECTLY, which is
 * what makes the ranking checkable on a CI machine, and everything else is
 * exercised through the degradation path.
 *
 * The properties that cost something real when lost:
 *   · every sub-ask is a CONTIGUOUS SPAN of the original task and nothing is
 *     dropped — an ask re-joined from pieces is no longer a decomposition of the
 *     thing it claims to decompose;
 *   · the WHOLE TASK is ask #1 — measured, the centroid beat the decomposed
 *     union on the two discriminating metrics, and dropping it threw that away;
 *   · a wall of prose with no blank line still decomposes — the splitter's line
 *     signals go silent exactly on the longest inputs;
 *   · page slots are allocated PER ASK and then UNIONED, never pooled into one
 *     global top-N: pooling let the loudest sub-ask spend the whole budget;
 *   · the closed-task toll moves SELECTION only — the reported `similarity`
 *     stays the true cosine, because a discounted number printed as a similarity
 *     is a lie about the measurement.
 *
 * Run: node --test addons/semantic-search/test/evidence.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.ATLAS_EMBED_DIR = path.join(os.tmpdir(), 'atlas-kit-no-encoder-' + process.pid)

const { subAsks, scan, semanticCandidates, MAX_SUB_ASKS } = await import('../api/evidence.mjs')
const { loadIndex, INDEX_SUBDIR } = await import('../api/semantic.mjs')
const { MODEL_ID, DIMS } = await import('../api/embed.mjs')
const { CHUNKER_VERSION } = await import('../api/chunk.mjs')

/* --- decomposition -------------------------------------------------------- */

test('a short task is itself, undecomposed — the single-vector case, reached by not splitting', () => {
  assert.deepEqual(subAsks('fix the flaky test'), ['fix the flaky test'])
  assert.deepEqual(subAsks('   '), [])
  assert.deepEqual(subAsks(null), [])
})

test('a multi-block task keeps the WHOLE TASK as ask #1, then its blocks', () => {
  const task = ['Rework the retrieval leg so it reports its own provenance honestly.', '', '- keep the two legs separate, never fused into one ranking', '- expose the similarity on every row rather than thresholding it'].join('\n')
  const asks = subAsks(task)
  assert.equal(asks[0], task.trim(), 'the centroid is a measured signal; it must stay ask #1')
  assert.ok(asks.length > 1)
  for (const a of asks.slice(1)) assert.ok(task.includes(a), `"${a.slice(0, 30)}…" is not a contiguous span of the task`)
})

test('a WALL OF PROSE still decomposes — the case the line signals go silent on', () => {
  const wall = Array.from({ length: 12 }, (_, i) => `Sentence ${i} explains one more constraint that the agent has to arrive already knowing about the system it is about to change.`).join(' ')
  const asks = subAsks(wall)
  assert.ok(asks.length > 2, 'one wall of prose came back as a single washed-out vector')
  assert.equal(asks[0], wall)
  for (const a of asks.slice(1)) assert.ok(wall.includes(a))
  // Every word of the task is covered by EXACTLY ONE span (overlap 0), so the
  // spans butt-join back into the original modulo the whitespace they trimmed.
  const joined = asks.slice(1).join(' ').replace(/\s+/g, ' ')
  assert.equal(joined, wall.replace(/\s+/g, ' '))
})

test('over the cap the shortest ADJACENT pieces merge — nothing is selected away', () => {
  const blocks = Array.from({ length: 14 }, (_, i) => `- requirement ${i}: ${'word '.repeat(20)}`)
  const asks = subAsks(blocks.join('\n'))
  assert.ok(asks.length <= MAX_SUB_ASKS, `${asks.length} asks exceeds the cap of ${MAX_SUB_ASKS}`)
  // Every requirement survives somewhere — merging, never dropping.
  for (let i = 0; i < 14; i++) assert.ok(asks.slice(1).some((a) => a.includes(`requirement ${i}:`)), `requirement ${i} was dropped`)
})

/* --- the scan ------------------------------------------------------------- */

/** A synthetic index: `pages` × `chunksPerPage`, each chunk a unit 2-D vector
 *  padded to DIMS so cosine against a basis query is exact. */
function makeIndex(spec) {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-ev-'))
  const dir = path.join(vaultPath, INDEX_SUBDIR)
  fs.mkdirSync(dir, { recursive: true })
  const rows = []
  const angles = []
  for (const [rel, chunkAngles] of Object.entries(spec)) {
    const abs = path.join(vaultPath, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    const paras = chunkAngles.map((_, i) => `paragraph ${i} of ${rel}`)
    fs.writeFileSync(abs, paras.join('\n\n') + '\n')
    let at = 0
    chunkAngles.forEach((a, i) => {
      rows.push({ path: rel, title: rel, crumb: `s${i}`, hash: `${rel}#${i}`, start: at, end: at + paras[i].length })
      angles.push(a)
      at += paras[i].length + 2
    })
  }
  const vecs = new Float32Array(rows.length * DIMS)
  angles.forEach((a, i) => {
    vecs[i * DIMS] = Math.cos(a)
    vecs[i * DIMS + 1] = Math.sin(a)
  })
  fs.writeFileSync(path.join(dir, 'vectors.f32'), Buffer.from(vecs.buffer))
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ vaultPath, builtAt: '2026-03-04T10:00:00Z', model: MODEL_ID, dtype: 'fp16', dims: DIMS, chunkerVersion: CHUNKER_VERSION, vectorsFile: 'vectors.f32', pages: Object.keys(spec).length, rows }),
  )
  return { vaultPath, idx: loadIndex(vaultPath) }
}

/** A query vector at `angle`, in the same 2-D plane. */
const qv = (angle) => {
  const v = new Float32Array(DIMS)
  v[0] = Math.cos(angle)
  v[1] = Math.sin(angle)
  return v
}

test('pages are chosen PER ASK and unioned — a loud ask cannot crowd out another ask’s answer', () => {
  // Two clusters, far apart. Ask A points at one, ask B at the other.
  const { vaultPath, idx } = makeIndex({
    'Wiki/A1.md': [0, 0.05],
    'Wiki/A2.md': [0.1],
    'Wiki/B1.md': [1.5, 1.55],
    'Wiki/B2.md': [1.45],
  })
  // perAskPages 1: with ONE global top-N, ask A's cluster would take the slot and
  // B's page would never appear. Allocated per ask and unioned, both are there.
  const rows = scan(idx, [qv(0), qv(1.5)], vaultPath, { perAskPages: 1, perPage: 3 })
  const pages = new Set(rows.map((r) => r.path))
  assert.ok(pages.has('Wiki/A1.md'), 'ask A’s best page is missing')
  assert.ok(pages.has('Wiki/B1.md'), 'ask B’s best page is missing — the legs collapsed into one global ranking')
})

test('a chosen page contributes its best CHUNKS, whole, not one preview', () => {
  const { vaultPath, idx } = makeIndex({ 'Wiki/Deep.md': [0, 0.02, 0.04, 1.4] })
  const rows = scan(idx, [qv(0)], vaultPath, { perAskPages: 4, perPage: 3 })
  assert.equal(rows.length, 3, 'perPage must bound chunks per page')
  // Each row is a whole chunk sliced live out of the page at its recorded range.
  for (const r of rows) assert.match(r.text, /^paragraph \d+ of Wiki\/Deep\.md$/)
  // …and the far-away chunk lost, so the ordering is by cosine and not by order.
  assert.ok(!rows.some((r) => r.text.endsWith('3 of Wiki/Deep.md')))
  assert.ok(rows[0].similarity >= rows[1].similarity)
})

test('the closed-task toll moves SELECTION, and never the reported similarity', () => {
  const spec = { 'Tasks/open.md': [0.3], 'Tasks/closed.md': [0] }
  const { vaultPath, idx } = makeIndex(spec)
  const closedPaths = new Set(['Tasks/closed.md'])

  // No toll: the closed page is the better cosine and wins.
  const even = scan(idx, [qv(0)], vaultPath, { perAskPages: 2, perPage: 1, closedPaths, doneWeight: 1 })
  assert.equal(even[0].path, 'Tasks/closed.md')
  assert.equal(even[0].closed, true, 'at weight 1 a closed page must still be LABELLED closed')
  assert.ok(Math.abs(even[0].similarity - 1) < 1e-6, 'the true cosine, undiscounted')

  // With the toll it loses the ordering — but its printed similarity is still 1.
  const tolled = scan(idx, [qv(0)], vaultPath, { perAskPages: 2, perPage: 1, closedPaths, doneWeight: 0.6 })
  assert.equal(tolled[0].path, 'Tasks/open.md')
  const closedRow = tolled.find((r) => r.path === 'Tasks/closed.md')
  assert.ok(Math.abs(closedRow.similarity - 1) < 1e-6, 'a discounted number printed as a similarity is a lie about the measurement')

  // Weight 0 is exclusion, on the same one code path.
  const excluded = scan(idx, [qv(0)], vaultPath, { perAskPages: 2, perPage: 1, closedPaths, doneWeight: 0 })
  assert.ok(!excluded.some((r) => r.path === 'Tasks/closed.md'))
})

test('Wiki/index.md never enters the dense leg — a chunk of it is twenty unrelated catalogue lines', () => {
  const { vaultPath, idx } = makeIndex({ 'Wiki/index.md': [0], 'Wiki/Real.md': [0.9] })
  const rows = scan(idx, [qv(0)], vaultPath, { perAskPages: 5, perPage: 3 })
  assert.ok(!rows.some((r) => r.path === 'Wiki/index.md'))
  assert.ok(rows.some((r) => r.path === 'Wiki/Real.md'))
})

test('a page deleted since the index was built is skipped, not crashed on', () => {
  const { vaultPath, idx } = makeIndex({ 'Wiki/Gone.md': [0], 'Wiki/Here.md': [0.1] })
  fs.rmSync(path.join(vaultPath, 'Wiki/Gone.md'))
  const rows = scan(idx, [qv(0)], vaultPath, { perAskPages: 5, perPage: 3 })
  assert.deepEqual([...new Set(rows.map((r) => r.path))], ['Wiki/Here.md'])
})

/* --- degradation ---------------------------------------------------------- */

test('the leg is OFF by default, and says so rather than pretending it found nothing', async () => {
  const out = await semanticCandidates({ asks: ['anything'], root: '/nowhere' })
  assert.equal(out.available, false)
  assert.match(out.reason, /ATLAS_EVIDENCE_SEMANTIC/)
  assert.deepEqual(out.rows, [])
  assert.equal(out.ms, 0, 'a disabled leg must cost nothing at all')
})

test('enabled but unusable degrades with a reason — a spawn never fails on retrieval', async () => {
  assert.match((await semanticCandidates({ asks: ['x'], root: '/no/such/vault', enabled: true })).reason, /no index/)
  assert.match((await semanticCandidates({ asks: [], root: '/tmp', enabled: true })).reason, /no asks/)
  assert.match((await semanticCandidates({ asks: ['x'], root: '', enabled: true })).reason, /no asks/)

  // A usable index but no encoder: still no throw, still a reason.
  const { vaultPath } = makeIndex({ 'Wiki/A.md': [0] })
  const out = await semanticCandidates({ asks: ['x'], root: vaultPath, enabled: true })
  assert.equal(out.available, false)
  assert.match(out.reason, /encoder not installed/)
  assert.deepEqual(out.rows, [])
})
