/* ------------------------------------------------------------------ *
 * The SEMANTIC leg of vault search — dense retrieval over the section index
 * built by `addons/semantic-search/scripts/index.mjs`.
 *
 * 🔴 TWO LEGS, NEVER ONE LIST. This is a SECOND retriever beside core's BM25F
 * (`api/src/vault-search.mjs`), and `GET /api/search` returns the two SEPARATELY
 * AND LABELLED. There is deliberately NO router, NO reciprocal-rank fusion, NO
 * score blending and NO merged ranking anywhere in this file, and adding one is
 * the single change this design exists to prevent:
 *
 *   · A router picks an engine BEFORE seeing any result. The consuming agent
 *     picks AFTER seeing the content — strictly more information, and no
 *     heuristic left to get wrong.
 *   · Fusion was measured, not assumed: RRF over these two legs scored MRR
 *     23.8% against the vector leg's own 70.4%, because averaging DESTROYS
 *     PROVENANCE — it hands the full-text leg's irrelevant top-10 the same
 *     1/(60+rank) mass as the right answers. Keeping the legs apart preserves
 *     exactly what fusion destroyed.
 *   · It turns abstention from a threshold guess into an INFORMATION one:
 *     "full-text 0 hits · semantic 24 hits, top similarity 0.31" is the honest
 *     signal, and it is the signal a fused list hides.
 *
 * ⚠️ THE VECTOR LEG CANNOT RETURN NOTHING ON ITS OWN. Cosine similarity to
 * every chunk in the vault is never empty, so this leg ALWAYS answers with a
 * confident-looking page list. That is why every row carries `similarity` and
 * why the score is exposed rather than hidden behind a threshold: a top score
 * of 0.31 means "nothing close", and only the reader can say so.
 *
 * COST. ~35 MB of float32 read once and scanned brute-force in ~14 ms for
 * 11,445 chunks; the query embed is ~34 ms. No ANN index, no vector DB, no new
 * service — an index structure would add complexity for nothing at this size.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import { CHUNKER_VERSION, pageBody } from './chunk.mjs'
import { MODEL_ID, DIMS, QUERY_PROMPT, embedRuntimeAvailable, resident, residentState, embed } from './embed.mjs'
import { readSweep } from './sweep.mjs'
import { healNote } from './heal.mjs'

/** Where an index lives for a vault. `data/` is the vault's machine-owned,
 *  gitignored projection layer — vectors NEVER go into `Wiki/` or `Tasks/`. */
export const INDEX_SUBDIR = path.join('data', 'atlas-index')
export const indexDirFor = (vaultPath) => path.join(vaultPath, INDEX_SUBDIR)

/** Kill switch that leaves the addon enabled — restores the pre-semantic
 *  response exactly (no `legs` entry from this addon). */
export const SEMANTIC_ENABLED = process.env.ATLAS_SEMANTIC !== '0'

/* An embed that hangs must not hang `/api/search`. The full-text leg is already
 * in hand by the time we await, so a timeout degrades to "semantic not running"
 * rather than failing the request.
 *
 * ⚠️ THE LOAD BUDGET IS SEPARATE AND MUCH LARGER THAN THE EMBED BUDGET, and
 * collapsing them into one number breaks the feature. A cold load is a MEASURED
 * ~2-3 s, so a 5 s budget would fail the first query after every idle eviction
 * on a merely-busy box — and abandoning it does not stop it: `resident()` keeps
 * loading in the background either way, so a tight budget buys nothing and costs
 * the query. 30 s here means "hung", not "slow". */
const TIMEOUT_MS = Number(process.env.ATLAS_SEMANTIC_TIMEOUT_MS || 5000)
const LOAD_TIMEOUT_MS = Number(process.env.ATLAS_SEMANTIC_LOAD_TIMEOUT_MS || 30000)

/** Reject after `ms` without holding the event loop open for that long. */
const deadline = (ms, what) =>
  new Promise((_, rej) => {
    const t = setTimeout(() => rej(new Error(`${what} exceeded ${ms} ms`)), ms)
    t.unref?.()
  })

const SNIPPET_CHARS = 320

/* --- the loaded index, cached per vault ---------------------------------- *
 * Reloaded when meta.json's mtime moves, so a re-index is picked up without a
 * restart — the same "operator-local state is live, not code" contract the vault
 * registry has. */
const cache = new Map() // vaultPath → { mtimeMs, meta, vecs, live, error }

/** The loaded index — `{ meta, vecs, live }`, or `{ error }`. Exported so the
 *  SPAWN-EVIDENCE leg (`evidence.mjs`) can pool the same vectors at CHUNK level
 *  instead of page level without a second loader: 35 MB read twice, cached
 *  twice, and drifting apart on the next provenance change is exactly the
 *  duplication this addon's structure avoids. */
export function loadIndex(vaultPath) {
  const dir = indexDirFor(vaultPath)
  const metaPath = path.join(dir, 'meta.json')
  let mtimeMs
  try {
    mtimeMs = fs.statSync(metaPath).mtimeMs
  } catch {
    cache.delete(vaultPath)
    return { error: 'no index — run addons/semantic-search/scripts/index.mjs' }
  }
  const hit = cache.get(vaultPath)
  if (hit && hit.mtimeMs === mtimeMs) return hit
  let entry
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    // An index built by a different encoder or a different chunker describes
    // text this process would not produce. Refusing it is the whole reason
    // provenance is recorded; a silently-mismatched vector file is unusable.
    if (meta.model !== MODEL_ID || meta.dims !== DIMS || meta.chunkerVersion !== CHUNKER_VERSION) {
      entry = { mtimeMs, error: `index provenance mismatch (model ${meta.model} dims ${meta.dims} chunker ${meta.chunkerVersion})` }
    } else {
      /* ⚠️ THE FILE NAME COMES FROM meta.json, NEVER FROM A CONSTANT HERE. The
       * indexer PING-PONGS between `vectors.f32` and `vectors.b.f32` so that
       * renaming meta.json is the only commit point, and it DELETES the one it
       * did not write.
       *
       * Hard-coding `vectors.f32` here makes the fault FLAP WITH REBUILD PARITY
       * rather than stay down, and that is the worse shape: after an odd number
       * of content-changing rebuilds the live name is `vectors.b.f32`, the leg
       * answers `available:false, reason: ENOENT …/vectors.f32`, and search
       * degrades to full-text-only silently — for a reason that is a bug — while
       * after an even number it works perfectly. A leg that is correct half the
       * time is harder to notice, and harder to trust once noticed, than one
       * that is simply down. */
      const vectorsFile = meta.vectorsFile || 'vectors.f32'
      const buf = fs.readFileSync(path.join(dir, vectorsFile))
      const vecs = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
      if (vecs.length < meta.rows.length * meta.dims) {
        entry = { mtimeMs, error: `${vectorsFile} shorter than meta.rows` }
      } else {
        // A written vector is L2-normalised and can never be all-zero; an
        // unwritten slot always is. Computed once, not per query.
        const live = []
        for (let i = 0; i < meta.rows.length; i++) if (vecs[i * meta.dims] !== 0 || vecs[i * meta.dims + 1] !== 0) live.push(i)
        entry = { mtimeMs, meta, vecs, live }
      }
    }
  } catch (e) {
    entry = { mtimeMs, error: String(e?.message || e) }
  }
  cache.set(vaultPath, entry)
  return entry
}

/** Compact provenance for the response — what the index IS, so a reader can
 * judge how stale it is instead of trusting a boolean.
 *
 * ⚠️ `builtAt` and `sweptAt` answer DIFFERENT questions and a reader needs
 * both: `builtAt` is when the index CONTENT last changed, `sweptAt` is when a
 * sweep last confirmed it matches the vault. An index built two days ago and
 * swept two minutes ago is CURRENT, and reporting only `builtAt` would read as
 * two days stale. `ageMinutes` is off `sweptAt` for that reason. */
function provenance(vaultPath, meta) {
  const sweep = readSweep(indexDirFor(vaultPath)) // null: pre-sweep index, or never swept
  const seen = sweep?.sweptAt || meta.builtAt
  return {
    builtAt: meta.builtAt,
    sweptAt: sweep?.sweptAt || null,
    ageMinutes: seen ? Math.round((Date.now() - Date.parse(seen)) / 60000) : null,
    vaultSha: sweep?.vaultSha || meta.vaultSha,
    pages: meta.pages,
    chunks: meta.rows.length,
    model: meta.model,
    dtype: meta.dtype,
    dims: meta.dims,
    chunkerVersion: meta.chunkerVersion,
  }
}

/** Is there a USABLE index for this vault — present, readable, and built by
 * this encoder and this chunker? A separate fact from "is the encoder
 * installed", and kept separate so each can be checked (and tested) on its own:
 * a machine with an index and no runtime and a machine with a runtime and no
 * index fail for genuinely different reasons. */
export function indexStatus(vaultPath) {
  const idx = loadIndex(vaultPath)
  if (idx.error) return { ok: false, reason: idx.error }
  return { ok: true, index: provenance(vaultPath, idx.meta) }
}

/** Why the semantic leg would not run right now, or its provenance if it would.
 *
 *  ⚠️ A MISSING ENCODER SAYS WHAT IS BEING DONE ABOUT IT (`healNote()`), because
 *  "encoder not installed" on a box whose self-heal is mid-download and on a box
 *  where the install has failed six times are the same sentence describing two
 *  situations that need opposite reactions from the reader. */
export function semanticStatus(vaultPath) {
  if (!SEMANTIC_ENABLED) return { available: false, reason: 'disabled (ATLAS_SEMANTIC=0)' }
  const idx = indexStatus(vaultPath)
  if (!idx.ok) return { available: false, reason: idx.reason }
  if (!embedRuntimeAvailable()) return { available: false, reason: `encoder not installed — ${healNote()}` }
  return { available: true, index: idx.index }
}

/** Top-K pages for one embedded query, MAX-POOLED over their chunks.
 * A page is as relevant as its most relevant section; summing would just
 * re-elect the longest page, which is the failure mode chunking exists to fix. */
function scanPages({ meta, vecs, live }, qv, cap) {
  const d = meta.dims
  const best = new Map() // path → { score, row }
  for (const i of live) {
    let s = 0
    for (let j = 0; j < d; j++) s += qv[j] * vecs[i * d + j]
    const r = meta.rows[i]
    const prev = best.get(r.path)
    if (!prev || s > prev.score) best.set(r.path, { score: s, row: r })
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, cap)
}

/** A preview of the matched SECTION, sliced live out of the page at the char
 * range the indexer recorded — so meta.json stays rows of metadata rather than
 * thousands of chunk bodies. Best-effort: if the page moved under us the preview
 * drifts, but the path and the similarity do not. */
function sectionSnippet(vaultPath, row) {
  const body = pageBody(vaultPath, row.path)
  if (body == null) return ''
  const start = row.start ?? 0
  // The ellipsis is decided from the RANGE, not from the collapsed string:
  // squashing whitespace shortens the text, so a length test would silently drop
  // the "there is more" marker on exactly the chunks that have more.
  const more = (row.end ?? body.length) > start + SNIPPET_CHARS
  const text = body
    .slice(start, start + SNIPPET_CHARS)
    .trim()
    .replace(/\s+/g, ' ')
  return more ? text + '…' : text
}

/**
 * The semantic leg, in the shape core's `searchAllLegs()` expects. NEVER throws
 * into the route: any failure degrades to `{ available: false, reason }`,
 * because a dead encoder must not take the full-text leg down with it.
 *
 * → { available, items, reason?, index?, model, ms? }
 *   items: [{ type, title, subtitle, path, section, similarity, snippet }] —
 *   the same fields core's own `items` carry, minus `score`, plus the matched
 *   section's heading breadcrumb and the cosine.
 */
export async function semanticSearch({ q, limit = 24, vaultPath }) {
  const status = semanticStatus(vaultPath)
  if (!status.available) return { available: false, items: [], reason: status.reason, model: residentState() }
  const query = String(q || '').trim()
  if (!query) return { available: true, items: [], index: status.index, model: residentState() }
  const idx = loadIndex(vaultPath)
  const t0 = performance.now()
  // Sampled BEFORE the query so `loaded:false` means "this query paid the cold
  // load", which is the reading that answers "why was that one slow".
  const model = residentState()
  try {
    const ctx = await Promise.race([resident(), deadline(LOAD_TIMEOUT_MS, 'encoder load')])
    const { vectors } = await Promise.race([embed(ctx, [QUERY_PROMPT(query)], { dims: idx.meta.dims }), deadline(TIMEOUT_MS, 'embed')])
    const hits = scanPages(idx, vectors[0], limit)
    const items = hits.map(({ score, row }) => {
      const folder = path.dirname(row.path)
      const isWiki = row.path === 'Wiki' || row.path.startsWith('Wiki' + path.sep)
      return {
        type: isWiki ? 'wiki' : 'note',
        title: row.title,
        subtitle: isWiki ? folder.replace(/^Wiki[/\\]?/, '') || 'Wiki' : folder === '.' ? 'vault' : folder,
        path: row.path,
        // The matched SECTION's heading breadcrumb — which part of a long page
        // answered, not just which page.
        section: row.crumb || '',
        similarity: Number(score.toFixed(4)),
        snippet: sectionSnippet(vaultPath, row),
      }
    })
    return { available: true, items, index: status.index, model, ms: Math.round(performance.now() - t0) }
  } catch (e) {
    return { available: false, items: [], reason: String(e?.message || e), model }
  }
}
