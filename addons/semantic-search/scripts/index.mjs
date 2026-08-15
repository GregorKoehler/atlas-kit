#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * Build / refresh the SEMANTIC index for a vault (the vault is READ-ONLY
 * apart from its own gitignored `data/atlas-index/`).
 *
 *   node addons/semantic-search/scripts/index.mjs
 *   node addons/semantic-search/scripts/index.mjs --vault atlas --full
 *
 * INCREMENTAL IS THE POINT, NOT AN OPTIMISATION. An Atlas is written many times
 * a day (phone sync, agents, the operator) and a full rebuild of a 1.6k-page
 * vault is ~91 min at fp16 — it cannot be the routine path. Every chunk carries
 * a CONTENT HASH over the exact string that was embedded, so a re-index copies
 * the vector of every chunk whose text is unchanged and only pays the encoder
 * for what actually moved. A typical edit session re-embeds tens of chunks out
 * of eleven thousand.
 *
 * ⚠️ THE HASH IS TAKEN OVER THE PROMPTED DOCUMENT STRING, not over the raw
 * chunk. That is deliberate: it is the exact input to the model, so the title,
 * the heading breadcrumb and the task prompt are all inside the identity. A hash
 * over the raw text would silently reuse a vector after a page's title changed,
 * which changes the embedding.
 *
 * ⚠️ THE ROW TABLE IS REGENERATED, NEVER PATCHED IN PLACE. Every sweep writes a
 * fresh vector file in the CURRENT chunk order, copying each unchanged vector
 * out of the previous file by hash. Deletions, moves and reordering are
 * therefore correct BY CONSTRUCTION — a chunk that no longer exists is simply
 * not written — with no tombstones and no compaction pass. Patching rows in
 * place is where staleness bugs live; this file deliberately cannot.
 *
 * ⚠️ A SWEEP THAT FINDS NOTHING CHANGED WRITES NOTHING. Measured: chunking and
 * hashing ~1,600 pages costs ~200 ms, so the sweep itself is cheap enough to run
 * every few minutes — but rewriting 35 MB of float32 288 times a day is not, and
 * an untouched index needs no rewrite to be correct.
 *
 * ⚠️ THE COMMIT POINT IS THE meta.json RENAME, and vectors ping-pong between two
 * filenames. A reader loads meta.json and the vectors file it NAMES, so it can
 * never pair a new vector file with an old row table — overwriting
 * `vectors.f32` in place would make exactly that pairing possible during every
 * re-index, i.e. silently wrong results on a live path.
 *
 * Guarded: threads capped, memory floor between batches, vectors streamed to
 * disk. An OOM here does not fail an index, it takes the dashboard down.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolveVault, defaultVaultKey } from '../../../api/src/vaults.mjs'
import { chunkVault, chunkText, CHUNKER_VERSION } from '../api/chunk.mjs'
import { MODEL_ID, DIMS, DTYPE, THREADS, DOC_PROMPT, load, embed, embedRuntimeAvailable } from '../api/embed.mjs'
import { INDEX_SUBDIR } from '../api/semantic.mjs'
import { dayKey, readSweep, rollSweep } from '../api/sweep.mjs'

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d
}
const flag = (n) => process.argv.includes('--' + n)

const vaultKey = arg('vault', process.env.ATLAS_SEMANTIC_VAULT || defaultVaultKey())
const explicitPath = arg('path')
const dtype = arg('dtype', DTYPE)
const batchSize = Number(arg('batch', 1))
const full = flag('full')
const outArg = arg('out')

const vaultPath = explicitPath || resolveVault(vaultKey)?.path
if (!vaultPath) {
  console.error(`unknown vault "${vaultKey}" — pass --path, or register it in api/src/vaults.json`)
  process.exit(2)
}
// A CLEAN NO-OP, not an error: this runs from cron every few minutes, and "the
// encoder is not installed yet" is an expected steady state (the self-heal in
// sweep.sh is what fixes it), not a misconfiguration to alarm on every five
// minutes. An unknown vault above IS one, and still exits non-zero.
if (!embedRuntimeAvailable()) {
  console.log('embedding runtime not installed — skipping (addons/semantic-search/install.sh)')
  process.exit(0)
}

const outDir = outArg || path.join(vaultPath, INDEX_SUBDIR)

/* --- headroom guard ------------------------------------------------------ *
 * The box also runs the dashboard, a reverse proxy and agent sessions. Stop and
 * persist what we have rather than OOM. */
const MIN_AVAIL_MB = Number(process.env.ATLAS_INDEX_MIN_AVAIL_MB || 800)
const availableMb = () => {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf-8').match(/^MemAvailable:\s+(\d+) kB$/m)
    return m ? Number(m[1]) / 1024 : 0
  } catch {
    return 0
  }
}
function assertHeadroom() {
  const avail = availableMb()
  if (avail && avail < MIN_AVAIL_MB) throw new Error(`ABORTED on memory headroom: MemAvailable ${avail.toFixed(0)} MB < ${MIN_AVAIL_MB} MB floor`)
}
const rssMb = () => process.memoryUsage.rss() / 2 ** 20

/** Dashboard live-stats — cosmetic by definition, so it can never throw. */
const STATS_FILE = process.env.ATLAS_INDEX_STATS_FILE
function writeStats(obj) {
  if (!STATS_FILE) return
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(obj))
  } catch {
    /* never fail real work for a progress display */
  }
}

const vaultSha = (() => {
  try {
    return execFileSync('git', ['-C', vaultPath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
  } catch {
    return null
  }
})()

/* --- what to embed ------------------------------------------------------- */
const { chunks, pages } = chunkVault(vaultPath)
const docs = chunks.map((c) => DOC_PROMPT(c.title, chunkText(c)))
const hashes = docs.map((d) => crypto.createHash('sha1').update(d).digest('hex').slice(0, 16))

/** The previous index as a hash→vector CACHE.
 *
 * ⚠️ Gated on the ENCODER (model/dtype/dims), NOT on the chunker version — and
 * that asymmetry is deliberate. The hash is over the exact prompted string, so a
 * vector is a pure function of that string: if a v2 chunk's text is identical to
 * some v1 chunk's, its vector is identical too and re-embedding it would buy
 * nothing. Gating the cache on the chunker would make every boundary change a
 * full rebuild and, worse, make chunker experiments too expensive to measure.
 * (The READER still refuses a stale chunkerVersion — a rebuild is required to
 * SERVE new boundaries, it is just not required to re-embed unchanged text.) */
function previous() {
  if (full) return null
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'meta.json'), 'utf-8'))
    if (meta.model !== MODEL_ID || meta.dims !== DIMS || meta.dtype !== dtype) {
      console.log(`previous index was built by a different encoder (model/dtype/dims) — full rebuild`)
      return null
    }
    if (meta.chunkerVersion !== CHUNKER_VERSION) {
      console.log(`chunker ${meta.chunkerVersion} → ${CHUNKER_VERSION}: boundaries changed, reusing vectors for text that did not`)
    }
    const buf = fs.readFileSync(path.join(outDir, meta.vectorsFile || 'vectors.f32'))
    const vecs = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
    const byHash = new Map()
    meta.rows.forEach((r, i) => {
      // Skip unwritten (all-zero) slots from an aborted run; a normalised vector
      // can never be all-zero.
      if (r.hash && !byHash.has(r.hash) && (vecs[i * meta.dims] !== 0 || vecs[i * meta.dims + 1] !== 0)) byHash.set(r.hash, i)
    })
    return { meta, vecs, byHash }
  } catch {
    return null
  }
}

const prev = previous()
const reuse = new Array(chunks.length).fill(-1)
let reused = 0
if (prev) {
  for (let i = 0; i < chunks.length; i++) {
    const at = prev.byHash.get(hashes[i])
    if (at !== undefined) (reuse[i] = at), reused++
  }
}
const todo = []
for (let i = 0; i < chunks.length; i++) if (reuse[i] === -1) todo.push(i)

/* WHEN THE INDEX WAS LAST CONFIRMED CURRENT — a few hundred bytes beside the
 * multi-MB meta.json, written by EVERY sweep including the ones that change
 * nothing. `builtAt` answers "when did the content last change"; this answers
 * "when did anyone last look", and only the second one tells an agent whether it
 * is querying a stale index. Rewriting meta.json just to move a timestamp would
 * put megabytes of disk churn on a sweep that has no work to do.
 *
 * It also carries the DAILY CHURN COUNTER the scorecard renders (api/sweep.mjs).
 * ⚠️ That file, never `data/scorecard.json`: scorecard.json has one writer and a
 * second producer on it is a silent clobber. The join happens at READ time in
 * core's dashboard bundle. The added cost to a no-op sweep is one 150-byte read. */
const writeSweep = (changed, embedded = 0) => {
  fs.mkdirSync(outDir, { recursive: true })
  const next = rollSweep(readSweep(outDir), {
    sweptAt: new Date().toISOString(),
    vaultSha,
    chunks: chunks.length,
    changed,
    embedded,
    day: dayKey(),
  })
  fs.writeFileSync(path.join(outDir, 'sweep.json'), JSON.stringify(next))
}

/* Nothing to embed AND the same rows in the same order → the index on disk is
 * already the index this run would produce. Exit before touching 35 MB. */
// ⚠️ The chunkerVersion test belongs here even though the CACHE ignores it: the
// reader refuses an index stamped with an old chunker, so exiting early on
// matching hashes alone would leave a rebuild permanently undone and the
// semantic leg permanently off.
if (
  prev &&
  !todo.length &&
  prev.meta.chunkerVersion === CHUNKER_VERSION &&
  prev.meta.rows.length === chunks.length &&
  prev.meta.rows.every((r, i) => r.hash === hashes[i] && r.path === chunks[i].path)
) {
  writeSweep(false)
  console.log(`${vaultKey}: ${chunks.length} chunks unchanged — index already current (built ${prev.meta.builtAt}, vault ${String(vaultSha).slice(0, 7)})`)
  process.exit(0)
}

console.log(
  `${vaultKey} (${vaultPath}) · ${pages} pages → ${chunks.length} chunks · reuse ${reused} · embed ${todo.length} · dtype=${dtype} threads=${THREADS} · MemAvailable ${availableMb().toFixed(0)} MB`,
)

/* ⚠️ PRE-FLIGHT HEADROOM CHECK, not just the between-batches one. From cron this
 * is a SECOND process loading its OWN copy of the encoder (~1.3 GB peak) beside
 * whatever the API already holds. Skipping a sweep is harmless — the next one
 * five minutes later catches up, and the index it would have written is still
 * the same index. An OOM takes the dashboard down. Checked only once there is
 * real work: a no-work sweep never gets here, and never constructs the encoder. */
const availNow = availableMb()
if (availNow && availNow < MIN_AVAIL_MB + 700) {
  // ⚠️ Deliberately does NOT touch sweep.json. `sweptAt` means "a sweep
  // confirmed the index matches the vault"; a skipped sweep confirmed nothing,
  // and stamping it would make a stale index report itself as fresh — the one
  // thing the staleness signal exists to prevent.
  console.log(`skipping this sweep: MemAvailable ${availNow.toFixed(0)} MB is too tight to load the encoder (need ~${MIN_AVAIL_MB + 700} MB) — the next sweep will catch up`)
  process.exit(0)
}

fs.mkdirSync(outDir, { recursive: true })

/* Ping-pong the vector file so the meta.json rename is the only commit point
 * (see the header). Write to whichever name the live index is NOT using. */
const liveName =
  prev?.meta?.vectorsFile ||
  (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(outDir, 'meta.json'), 'utf-8')).vectorsFile || 'vectors.f32'
    } catch {
      return null
    }
  })()
const vectorsFile = liveName === 'vectors.f32' ? 'vectors.b.f32' : 'vectors.f32'

const rowBytes = DIMS * 4
const fd = fs.openSync(path.join(outDir, vectorsFile), 'w+')
fs.ftruncateSync(fd, chunks.length * rowBytes)
const writeRow = (row, f32) => fs.writeSync(fd, Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength), 0, rowBytes, row * rowBytes)

// Copy every unchanged vector first — no model needed, and it means an aborted
// embed still leaves a usable (partial) index rather than a mostly-empty one.
for (let i = 0; i < chunks.length; i++) {
  if (reuse[i] === -1) continue
  writeRow(i, prev.vecs.subarray(reuse[i] * prev.meta.dims, reuse[i] * prev.meta.dims + DIMS))
}

let ctx = null
let loadMs = 0
let done = 0
let tokens = 0
let peakRss = rssMb()
let aborted = null
const t0 = performance.now()

if (todo.length) {
  const idleBefore = rssMb()
  ctx = await load({ dtype })
  loadMs = ctx.loadMs
  console.log(`model load ${loadMs.toFixed(0)} ms · RSS +${(rssMb() - idleBefore).toFixed(0)} MB`)
  // Length-bucketed order: a batch pads to roughly its own longest member
  // instead of to the vault's longest. Each row is still written back at its
  // ORIGINAL offset, so nothing about the output changes.
  const order = [...todo].sort((a, b) => docs[a].length - docs[b].length)
  try {
    for (let i = 0; i < order.length; i += batchSize) {
      assertHeadroom()
      const idx = order.slice(i, i + batchSize)
      const r = await embed(
        ctx,
        idx.map((k) => docs[k]),
        { dims: DIMS },
      )
      tokens += r.tokens
      r.vectors.forEach((v, j) => writeRow(idx[j], v))
      done += idx.length
      peakRss = Math.max(peakRss, rssMb())
      if (done % (batchSize * 25) === 0 || done === order.length) {
        const s = (performance.now() - t0) / 1000
        const rate = done / s
        console.log(
          `${done}/${order.length}  ${rate.toFixed(2)} ch/s  ${(s / 60).toFixed(1)} min  eta ${((order.length - done) / rate / 60).toFixed(0)} min  rss ${rssMb().toFixed(0)} MB  avail ${availableMb().toFixed(0)} MB`,
        )
        writeStats({ embedded: [done, order.length], 'ch/s': Number(rate.toFixed(2)), reused, 'RSS MB': Math.round(rssMb()) })
      }
    }
  } catch (e) {
    aborted = String(e.message || e)
    console.error(`\n${aborted}`)
  }
}
fs.closeSync(fd)

const wallS = (performance.now() - t0) / 1000
const meta = {
  vault: vaultKey,
  vaultPath,
  vaultSha,
  builtAt: new Date().toISOString(),
  model: MODEL_ID,
  dtype,
  dims: DIMS,
  chunkerVersion: CHUNKER_VERSION,
  vectorsFile,
  pages,
  reused,
  embedded: done,
  aborted,
  tokens,
  indexSeconds: wallS,
  loadMs,
  peakRssMb: peakRss,
  rows: chunks.map((c, i) => ({ path: c.path, title: c.title, crumb: c.crumb, hash: hashes[i], start: c.start, end: c.end })),
}
// THE COMMIT POINT. Write beside, then rename — a reader either sees the whole
// old index or the whole new one, never a row table from one and vectors from
// the other.
fs.writeFileSync(path.join(outDir, 'meta.json.new'), JSON.stringify(meta))
fs.renameSync(path.join(outDir, 'meta.json.new'), path.join(outDir, 'meta.json'))
writeSweep(true, done)
if (liveName && liveName !== vectorsFile) {
  try {
    fs.unlinkSync(path.join(outDir, liveName))
  } catch {
    /* first build, or already gone */
  }
}

console.log(`\n${aborted ? 'PARTIAL' : 'done'}: ${reused} reused + ${done} embedded of ${chunks.length} chunks in ${(wallS / 60).toFixed(1)} min · peak RSS ${peakRss.toFixed(0)} MB`)
console.log(`wrote ${outDir}/${vectorsFile} + meta.json  (vault ${vaultSha ? vaultSha.slice(0, 7) : 'not a git repo'})`)
if (STATS_FILE) {
  try {
    fs.unlinkSync(STATS_FILE)
  } catch {
    /* already gone */
  }
}
if (aborted) process.exitCode = 3
