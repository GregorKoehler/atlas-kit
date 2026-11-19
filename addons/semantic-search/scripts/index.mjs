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
 * ⚠️ THE COMMIT POINT IS THE meta.json RENAME, and every run writes its OWN
 * vector file. A reader loads meta.json and the vectors file it NAMES, so it can
 * never pair a new vector file with an old row table — overwriting a live file
 * in place would make exactly that pairing possible during every re-index, i.e.
 * silently wrong results on a live path.
 *
 * 🔴 ONE RUN AT A TIME, AND A PARTIAL MAY NOT REGRESS. Measured in the field: a
 * bulk vault commit made one run take over an hour and nothing stopped the next
 * five-minute ticks starting beside it — up to 5 ran at ~900 MB each. Each picked
 * its target from the live name at START (ping-pong between two names) and
 * opened it `w+`, so two runs could truncate one file, and each unlinked its
 * start-time live name at the end, which could be the file meta.json named by
 * then. `previous()` then failed, its bare catch said "first build", and an
 * aborted run committed anyway: a nearly empty partial replaced a full index —
 * 18 % of rows held a vector while the scorecard said every chunk was indexed.
 * So: `takeSweepLock`, per-run target files, a commit gate on `filled`, and a
 * loud refusal in `previous()`. test/index-sweep.test.mjs pins each property.
 *
 * Guarded: threads capped, memory floor between batches, vectors streamed to
 * disk. An OOM here does not fail an index, it takes the dashboard down.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolveVault, defaultVaultKey } from '../../../api/src/vaults.mjs'
import { chunkVault, chunkText, CHUNKER_VERSION } from '../api/chunk.mjs'
import { MODEL_ID, DIMS, DTYPE, THREADS, DOC_PROMPT, load, embed, embedRuntimeAvailable } from '../api/embed.mjs'
import { INDEX_SUBDIR } from '../api/semantic.mjs'
import { countFilled, dayKey, readSweep, rollSweep } from '../api/sweep.mjs'

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
const metaPath = path.join(outDir, 'meta.json')

/* --- single flight ------------------------------------------------------- *
 * ⚠️ A KERNEL LOCK, not a pidfile: flock(2) belongs to the open file description,
 * and the kernel drops it when the last fd on that description closes, so a
 * SIGKILLed or OOM-killed holder can never freeze the sweep. Node has no flock(),
 * so `flock -n 3` locks the description this process SHARES with the child; the
 * child exits and the lock stays, held by the fd below until this process dies.
 * fs.openSync sets O_CLOEXEC, so a `git` child cannot inherit and outlive it.
 *
 * Keyed to the directory it protects, so it covers the cron sweep and a manual
 * run alike. It costs one short-lived spawn, before the vault walk, so a losing
 * run touches nothing and a no-op sweep stays ~0.3 s. No `flock` binary → refuse:
 * running unlocked is how the overlap above happened. */
function takeSweepLock() {
  fs.mkdirSync(outDir, { recursive: true })
  const fd = fs.openSync(path.join(outDir, 'sweep.lock'), 'a')
  const r = spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'inherit', fd] })
  if (r.status === 0) return fd
  if (r.status === 1) {
    console.log(`${vaultKey}: another sweep holds ${outDir}/sweep.lock — skipping this run`)
    process.exit(0)
  }
  console.error(`cannot take the sweep lock (${r.error?.message || `flock exited ${r.status}`}) — refusing to run unlocked`)
  process.exit(2)
}
takeSweepLock()

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
 * core's dashboard bundle. The added cost to a no-op sweep is one 150-byte read.
 *
 * `chunks` and `filled` describe the index meta.json names AFTER this run, which
 * is not this run's attempt when an aborted run discards itself. */
const writeSweep = ({ changed, embedded = 0, chunks: total, filled, aborted = null }) => {
  const next = rollSweep(readSweep(outDir), {
    sweptAt: new Date().toISOString(),
    vaultSha,
    chunks: total,
    filled,
    changed,
    embedded,
    day: dayKey(),
    aborted,
  })
  fs.writeFileSync(path.join(outDir, 'sweep.json'), JSON.stringify(next))
}

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
  // No meta.json is the ONE genuine first build. Everything below is a live index
  // this run failed to read.
  if (!fs.existsSync(metaPath)) return null
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    if (meta.model !== MODEL_ID || meta.dims !== DIMS || meta.dtype !== dtype) {
      console.log(`previous index was built by a different encoder (model/dtype/dims) — full rebuild`)
      return null
    }
    if (meta.chunkerVersion !== CHUNKER_VERSION) {
      console.log(`chunker ${meta.chunkerVersion} → ${CHUNKER_VERSION}: boundaries changed, reusing vectors for text that did not`)
    }
    const buf = fs.readFileSync(path.join(outDir, meta.vectorsFile || 'vectors.f32'))
    const vecs = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
    if (vecs.length < meta.rows.length * meta.dims) throw new Error(`${meta.vectorsFile || 'vectors.f32'} is shorter than meta.rows`)
    const byHash = new Map()
    meta.rows.forEach((r, i) => {
      // Skip unwritten (all-zero) slots from an aborted run; a normalised vector
      // can never be all-zero.
      if (r.hash && !byHash.has(r.hash) && (vecs[i * meta.dims] !== 0 || vecs[i * meta.dims + 1] !== 0)) byHash.set(r.hash, i)
    })
    return { meta, vecs, byHash }
  } catch (e) {
    /* 🔴 THIS CATCH USED TO `return null`, i.e. "first build": reuse 0 of every
     * chunk, a full re-embed (well over an hour on a mature vault) started
     * unattended on the box, on every tick, with nobody told. So it stops instead.
     * A corrupt index heals only by a decision (`--full`, or re-importing one built
     * elsewhere), and the scorecard shows the aborted state until someone makes it. */
    const reason = `live index unreadable: ${e?.message || e}`
    console.error(`\n🔴 ${outDir}: ${reason}\n🔴 NOT treating this as a first build. Nothing was written. Re-import an index, or run --full to re-embed everything on purpose.`)
    writeSweep({ changed: false, chunks: chunks.length, filled: null, aborted: reason })
    process.exit(4)
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
  writeSweep({ changed: false, chunks: chunks.length, filled: chunks.length })
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

/* A TARGET NO OTHER RUN CAN NAME, so the meta.json rename is the only commit point
 * (see the header) even if the lock is ever bypassed: two runs can never truncate
 * one file. The pid in the name is how `removeUnnamedVectors` tells another run's
 * in-progress target from a dead run's leftover. */
const vectorsFile = `vectors.${process.pid}.${Date.now().toString(36)}.f32`

const rowBytes = DIMS * 4
const fd = fs.openSync(path.join(outDir, vectorsFile), 'wx+')
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
  // Length-bucketed order: a batch pads to roughly its own longest member
  // instead of to the vault's longest. Each row is still written back at its
  // ORIGINAL offset, so nothing about the output changes.
  const order = [...todo].sort((a, b) => docs[a].length - docs[b].length)
  // The load sits inside the try: a load that fails is an aborted run like any
  // other, and goes through the same commit gate below.
  try {
    const idleBefore = rssMb()
    ctx = await load({ dtype })
    loadMs = ctx.loadMs
    console.log(`model load ${loadMs.toFixed(0)} ms · RSS +${(rssMb() - idleBefore).toFixed(0)} MB`)
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
const filled = reused + done

/** What the index meta.json names RIGHT NOW holds, read at the commit decision and
 * not at start: under a bypassed lock it may have moved. An index built before
 * `filled` existed is counted. null = nothing to protect: unreadable, or from an
 * encoder/chunker the reader refuses, which serves zero rows however full it is. */
function liveIndex() {
  try {
    const m = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    if (m.model !== MODEL_ID || m.dims !== DIMS || m.chunkerVersion !== CHUNKER_VERSION) return null
    return { rows: m.rows.length, filled: Number.isFinite(m.filled) ? m.filled : countFilled(path.join(outDir, m.vectorsFile || 'vectors.f32'), m.rows.length, m.dims) }
  } catch {
    return null
  }
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/* Removes only what the CURRENT meta.json does not name, and never another LIVE
 * run's target: without the second rule, a bypassed lock lets this delete a file
 * that run is about to commit, and meta.json then names a missing file. Re-read
 * here, after the rename, because an overlapping run may have committed since.
 * The two legacy ping-pong names carry no pid and are always safe once unnamed.
 * A leftover of a killed run is removed by the next run that commits. */
function removeUnnamedVectors() {
  const named = JSON.parse(fs.readFileSync(metaPath, 'utf-8')).vectorsFile || 'vectors.f32'
  for (const f of fs.readdirSync(outDir)) {
    const m = f.match(/^vectors(?:\.b|\.(\d+)\.[0-9a-z]+)?\.f32$/)
    if (!m || f === named) continue
    if (m[1] && Number(m[1]) !== process.pid && pidAlive(Number(m[1]))) continue
    try {
      fs.unlinkSync(path.join(outDir, f))
    } catch {
      /* already gone */
    }
  }
}

/* 🔴 A PARTIAL MAY NOT REGRESS. An aborted run commits only if it leaves at least
 * as many filled rows as the live index, which is how a cold build still resumes
 * across aborts (each partial holds at least what the last one did). Otherwise it
 * throws its work away and the live index stays byte-identical: its vectors may be
 * older, but a stale full index answers every query and a fresh hollow one does not.
 * sweep.json records the abort either way. */
const live = aborted ? liveIndex() : null
const discard = Boolean(live) && filled < live.filled
if (discard) {
  fs.unlinkSync(path.join(outDir, vectorsFile))
  writeSweep({ changed: false, embedded: done, chunks: live.rows, filled: live.filled, aborted })
  console.error(`\nDISCARDED: this aborted run filled ${filled} of ${chunks.length} rows, the live index holds ${live.filled} of ${live.rows} — left it untouched`)
} else {
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
    filled,
    aborted,
    tokens,
    indexSeconds: wallS,
    loadMs,
    peakRssMb: peakRss,
    rows: chunks.map((c, i) => ({ path: c.path, title: c.title, crumb: c.crumb, hash: hashes[i], start: c.start, end: c.end })),
  }
  // THE COMMIT POINT. Write beside, then rename — a reader either sees the whole
  // old index or the whole new one, never a row table from one and vectors from
  // the other. The temp name is per-run for the same reason the target is: a
  // shared name lets one run rename another's half-written meta.json into place.
  const metaNew = `${metaPath}.${process.pid}.new`
  fs.writeFileSync(metaNew, JSON.stringify(meta))
  fs.renameSync(metaNew, metaPath)
  writeSweep({ changed: true, embedded: done, chunks: chunks.length, filled, aborted })
  removeUnnamedVectors()

  console.log(`\n${aborted ? 'PARTIAL' : 'done'}: ${reused} reused + ${done} embedded of ${chunks.length} chunks in ${(wallS / 60).toFixed(1)} min · peak RSS ${peakRss.toFixed(0)} MB`)
  console.log(`wrote ${outDir}/${vectorsFile} + meta.json  (vault ${vaultSha ? vaultSha.slice(0, 7) : 'not a git repo'})`)
}
if (STATS_FILE) {
  try {
    fs.unlinkSync(STATS_FILE)
  } catch {
    /* already gone */
  }
}
if (aborted) process.exitCode = 3
