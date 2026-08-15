/* ------------------------------------------------------------------ *
 * The SEMANTIC leg of the SPAWN-EVIDENCE retriever — the addon side of core's
 * `api/src/atlas-evidence-semantic.mjs` seam.
 *
 * Core builds an agent's opening evidence block with two instruments: a
 * keyword/IDF text scan and the typed `queryAtlas()` lookup. Neither can reach a
 * fact whose only handle is a word the task never used — measured on 28 cases
 * where query and answer page share no vocabulary, lexical recall@10 was 7.1%
 * against dense retrieval's 96.4%, and cross-lingual DE↔EN 0% against 100%.
 * This closes that gap, over the SAME index `/api/search` reads.
 *
 * 🔴 IT IS OFF BY DEFAULT (`ATLAS_EVIDENCE_SEMANTIC=1` to run it) — READ THE
 * VERDICT BEFORE YOU ENABLE OR EXTEND IT. Measured on 13 real spawn tasks each
 * paired with the one Atlas fact it has to arrive knowing, this leg does NOT yet
 * move the metric it was built for. Keyword-only and keyword+semantic both put
 * the fact's PAGE in the block 84.6% of the time and the PASSAGE carrying it
 * 23.1% of the time. Identical.
 *
 * What it does add is ~1-2 pages per spawn that the keyword-only block never
 * names at all, quoted with a section breadcrumb and a similarity, for ~4.5 KB
 * and ~709 ms on every spawn — a real cost against a measured zero benefit,
 * which is why it does not ship enabled.
 *
 * WHY, measured rather than guessed, because the fix follows from it: the
 * binding constraint is the INDEX'S CHUNK SIZE, not the retriever here. The
 * index is built for SEARCH, where the deliverable is a page LINK, so its
 * sections run to ~2048 chars — and the paragraph carrying a needed constraint
 * is rarely what a 2048-char section is *about*. The carrier chunk was the
 * page's top-scoring chunk in 1 of 11 cases, and even with an UNBOUNDED section
 * budget the carrier renders in only 4 of 13. So the follow-up is a finer
 * chunking for the evidence path — not more pages, more chunks per page, or a
 * bigger budget, all of which were swept and none of which moved it. A live
 * paragraph-level re-rank of the retrieved chunks was tried and REJECTED on
 * cost: >10 s per task, against a spawn path deadline-bounded at 6 s.
 *
 * 🔴 IT POOLS AT CHUNK LEVEL, NOT PAGE LEVEL, and that is the difference between
 * this and `semanticSearch()`. A search RESULT is a page — you click through, so
 * "this page is as relevant as its best section" is right. An EVIDENCE BLOCK
 * quotes passages and the agent never clicks through, so the question is not
 * which page but which PARAGRAPH. Pages are chosen by their best chunk; each
 * chosen page then contributes its best few chunks, whole.
 *
 * 🔴 A SPAWN TASK IS NOT A QUERY — but the centroid is not worthless either, and
 * that too is measured. A dev task is multi-topic prose, so it is DECOMPOSED
 * into its constituent asks, each embedded (in ONE batch, not N forward passes),
 * with page slots allocated PER ASK and then unioned. ⚠️ The whole task is kept
 * as the first ask: on its own it BEAT the decomposed union (needed page in the
 * top 3: 53.8% vs 30.8%). See `subAsks` for the full comparison.
 *
 * 🔴 UNION, NEVER FUSE — the rule `semantic.mjs` states for search, for the same
 * measured reason. The typed lookup and the keyword pass are untouched and keep
 * their own sections; this leg gets its OWN, labelled, with a similarity on
 * every row. The union INSIDE this leg is across sub-asks of one task — one
 * instrument reading one document, not two instruments blended.
 *
 * COST, and why it is bounded rather than assumed. This runs SYNCHRONOUSLY while
 * an agent starts, unlike `/api/search` where a user is already waiting on a
 * page. The caller is the API process itself, so the encoder is the SAME
 * resident copy `/api/search` uses — no second ~660 MB model. What is added is
 * ONE batched embed of N sub-asks plus ONE brute-force pass over the chunk
 * table. N is capped, and the whole leg sits under ONE deadline: if the encoder
 * is cold, hung, uninstalled or the index is missing, this returns
 * `available:false` and the block is byte-identical to the keyword-only one it
 * has always been. A spawn must never fail — or stall — because retrieval was
 * unavailable.
 * ------------------------------------------------------------------ */
import { loadIndex, semanticStatus } from './semantic.mjs'
import { resident, embed, QUERY_PROMPT } from './embed.mjs'
import { pageBody, windowRanges } from './chunk.mjs'

/* `Wiki/index.md` is a large list of one-line page summaries, so a 2048-char
 * chunk of it is twenty unrelated catalogue entries — a whole section's byte
 * budget spent on something that is not a passage. The block already renders
 * index.md by LINE in its own section. `Wiki/log.md` is deliberately NOT
 * excluded: its chunks ARE its `## [date] op | title` entries, i.e. real
 * passages, and the dense leg reaches ones the log section's term scoring
 * misses. (The keyword pass excludes both, but for an IDF reason — they contain
 * every term — that does not apply to cosine.) */
const INDEX_MD = 'Wiki/index.md'

/** 🔴 OFF BY DEFAULT, on the strength of this module's own measurement — set
 * `ATLAS_EVIDENCE_SEMANTIC=1` to run it.
 *
 * ⚠️ Separate from `/api/search`'s `ATLAS_SEMANTIC` on purpose, and inverted
 * relative to it: search MEASURED WELL and is on whenever the addon is enabled,
 * this path measured flat and is off. One switch for both would force the wrong
 * answer on one of them. */
export const EVIDENCE_SEMANTIC_ENABLED = process.env.ATLAS_EVIDENCE_SEMANTIC === '1'

// Sub-asks are embedded in ONE batch, so the cap is about the encoder's context
// and about not diluting the union, not about latency. 6 covers the shape a real
// spawn task has: a context paragraph, a numbered list of requirements, a
// closing constraint.
export const MAX_SUB_ASKS = Number(process.env.ATLAS_EVIDENCE_SUB_ASKS || 6)
// Under this a block is not an ask — it is a heading, a bare file path, a
// "Context:" label. It merges into what follows rather than spending a vector.
// ⚠️ Deliberately LOW. At 120 it swallowed whole paragraphs: a three-paragraph
// task whose opening line was 72 chars collapsed to ONE ask, i.e. silently back
// to the single-vector case this module exists to avoid.
const MIN_ASK_CHARS = 60
/* …AND A CEILING, which is the half a line-signal splitter is missing. It splits
 * only where a writer signals a new thought — a blank line, a list item, a
 * heading — so a task written as ONE WALL OF PROSE has no signal to split on and
 * comes back as a single ask, i.e. exactly the washed-out single vector
 * decomposition exists to avoid, silently and precisely for the longest inputs.
 *
 * 1024 chars is the MEDIAN LENGTH OF A DOCUMENT CHUNK in a live index (n=10,183:
 * p25 661, median 1029, p75 1766). That is the anchor that matters: an ask is
 * compared against those chunks by cosine, so an ask covering much more ground
 * than the typical passage it must match is asking one vector to be about more
 * things than any single answer is. */
const MAX_ASK_CHARS = 1024
/* Pages EACH SUB-ASK contributes, and how many chunks of a chosen page are
 * quoted. ⚠️ PER-ASK, then unioned — NOT one global top-N by best-over-asks.
 * Measured, that distinction is the whole value of decomposing: pooling to one
 * global list let the loudest sub-ask spend the page budget, and the fact's page
 * fell out of the set for 5 of 11 cases — decomposition scored WORSE than a
 * single vector (54.5% vs 90.9% page recall) purely from the collapse.
 * Allocating per ask and unioning is what makes a decomposed task strictly
 * additive: every sub-ask gets its own slots, so no ask can crowd out another's
 * answer. */
const PER_ASK_PAGES = 6
const PER_PAGE = 3

/* The WHOLE leg's budget, not per phase. A measured cold encoder load is
 * ~2.1-2.9 s, which is a fine answer for a user staring at a search box and a
 * bad one for a spawn. One deadline over the whole thing is the honest bound:
 * exceed it and the spawn proceeds with keyword-only evidence, which is exactly
 * the no-addon behaviour. The first spawn after an idle eviction is the slow one. */
const DEADLINE_MS = Number(process.env.ATLAS_EVIDENCE_SEMANTIC_MS || 6000)

/* --- decomposition --------------------------------------------------- */

/** A task's constituent asks, as contiguous spans of the ORIGINAL text.
 *
 * Splits where a writer signals a new thought — a blank line, a list item, a
 * heading — then merges anything under the floor FORWARD into what follows, the
 * same left-to-right fold `chunk.mjs` uses on vault sections and for the same
 * reason: a near-empty vector is not harmless, it is promiscuous, sitting at
 * middling cosine to everything.
 *
 * ⚠️ Both halves of that fold are needed. A task with no blank line, list item
 * or heading in it — one wall of prose — offers nothing to split ON, so anything
 * over `MAX_ASK_CHARS` also goes through `chunk.mjs`'s own `windowRanges`
 * (paragraphs first; a single paragraph longer than the window is sliced blind —
 * rare, and better than dropping it), IMPORTED rather than reimplemented so the
 * two can never drift. It is passed `overlap: 0`, which is what keeps the
 * "exactly one span" invariant below true — the chunker's 200-char carry-over
 * would put some words in two asks.
 *
 * ⚠️ Nothing is DROPPED. Over the cap, the two shortest adjacent pieces merge
 * until the count fits, so every word of the task is still covered by exactly
 * one vector. Selecting "the N most important asks" would need a ranker, and a
 * ranker that decides what the agent gets to know before anything has been
 * retrieved is the router this design exists without.
 *
 * A short task (a chat's opening line, a one-sentence spawn) has one block and
 * comes back as itself — the single-vector case, reached by not decomposing
 * rather than by a mode flag.
 */
export function subAsks(task, { max = MAX_SUB_ASKS, minChars = MIN_ASK_CHARS } = {}) {
  const text = String(task || '').trim()
  if (!text) return []
  /* ⚠️ Offsets, not strings, and for the same reason `chunk.mjs`'s
   * `windowRanges` works in offsets: re-joining pieces with '\n' produces text
   * that never appeared in the task (the real separator is usually '\n\n'), so a
   * merged ask would no longer be a span of the thing it claims to decompose. */
  const parts = [] // [start, end)
  let start = null
  let end = 0
  let at = 0
  const flush = () => {
    if (start !== null && text.slice(start, end).trim()) parts.push([start, end])
    start = null
  }
  for (const line of text.split('\n')) {
    if (!line.trim() || /^\s*(?:[-*•]|\d+[.)])\s/.test(line) || /^#{1,6}\s/.test(line)) flush()
    if (start === null) start = at
    end = at + line.length
    at += line.length + 1
  }
  flush()
  // The ceiling, applied BEFORE the single-block early return below — that
  // return is the exact path a wall of prose takes, so a fallback placed after
  // it would never run on the one input it exists for. A part already inside the
  // ceiling comes back as itself, so every short-enough task is unchanged.
  const split = parts.flatMap(([a, b]) => windowRanges(text, a, b, MAX_ASK_CHARS, 0))
  const span = ([a, b]) => text.slice(a, b).trim()
  if (split.length <= 1) return split.map(span)

  const out = []
  /* ⚠️ THE WHOLE TASK IS ITSELF THE FIRST ASK, and that is a measured
   * correction, not belt-and-braces. Decomposition was built on the assumption
   * that a centroid over a multi-topic task points nowhere useful — and on 13
   * real spawn tasks the single whole-task vector BEAT the decomposed union on
   * both discriminating metrics: the needed page in the top 3 (53.8% vs 30.8%)
   * and the retrieved chunk carrying the fact (46.2% vs 38.5%). Page recall was
   * identical (76.9%). The centroid is apparently a real signal about what a
   * task is ABOUT, and dropping it to chase the sub-asks threw it away. Since
   * page slots are allocated PER ASK and then unioned, adding it back costs one
   * vector in the same batch and cannot lose anything the sub-asks would have
   * found: the union is strictly larger than either alone.
   * ⚠️ Those 13 tasks run 0.7-0.9 KB, so this measures decomposition on the
   * SHORT end where a centroid is least diluted. */
  const len = ([a, b]) => b - a
  for (const p of split) {
    const last = out.length - 1
    if (last >= 0 && len(out[last]) < minChars) out[last][1] = p[1]
    else out.push([...p])
  }
  // The final piece has nothing after it to be absorbed by, so it folds backward.
  if (out.length > 1 && len(out[out.length - 1]) < minChars) out[out.length - 2][1] = out.pop()[1]
  // Over the cap, merge the shortest ADJACENT pair repeatedly — contiguity is
  // what keeps every ask a real span of the task rather than a bag of fragments.
  // `max - 1`, because the whole task takes the first slot.
  while (out.length > max - 1) {
    let pick = 0
    let best = Infinity
    for (let i = 0; i < out.length - 1; i++) {
      const pair = len(out[i]) + len(out[i + 1])
      if (pair < best) (best = pair), (pick = i)
    }
    out[pick][1] = out.splice(pick + 1, 1)[0][1]
  }
  return [text, ...out.map(span)] // …the whole task first — see above
}

/* --- the scan --------------------------------------------------------- */

/** Resolve after `ms` without holding the event loop open for that long. */
const deadline = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve('deadline'), ms)
    t.unref?.()
  })

/**
 * Per sub-ask: the best chunk of every page, ranked, top `perAskPages` taken.
 * Then UNION those page sets, and quote each page's best chunks — including one
 * per ask that chose it, so a page two different sub-asks landed on contributes
 * the paragraph each of them actually matched rather than one paragraph twice.
 *
 * One pass over the vectors for all asks together. ~10k chunks × 768 dims is
 * ~7M multiply-adds per ask (~14 ms); scanning once per ask would re-read the
 * same 35 MB N times for exactly the same arithmetic.
 *
 * Exported for the tests: it takes query vectors DIRECTLY, so the toll's effect
 * on ranking is checkable on a machine with no encoder and no index — which is
 * every CI machine, and the reason the rest of this module is tested through its
 * degradation path.
 */
export function scan(idx, qvs, root, { perAskPages = PER_ASK_PAGES, perPage = PER_PAGE, closedPaths, doneWeight = 1 }) {
  const d = idx.meta.dims
  const n = qvs.length
  // A closed task's cosine is charged the same toll the keyword leg charges its
  // IDF score (see DONE_WEIGHT in api/src/atlas-candidates.mjs). ⚠️ It applies to
  // the SELECTION score only: `similarity` on the row stays the true cosine,
  // because a discounted number printed as a similarity is a lie about the
  // measurement. ⚠️ And a multiplier bites far harder here than on IDF — cosines
  // cluster in 0.45-0.71, so ×0.6 is a −0.24 shift where the whole top-8 spans
  // ~0.05. On this leg a down-weight is exclusion in all but name.
  const weightOf = (p) => (closedPaths?.has(p) ? doneWeight : 1)
  // Two things are needed and they are NOT the same, which cost a measured false
  // negative: `perAsk` (a page's best score FOR EACH ask) decides which pages are
  // chosen, and `chunks` (every chunk, at its best score over all asks) decides
  // which paragraphs OF a chosen page are quoted. Keeping only the per-ask best
  // chunk for both meant a page could never contribute more distinct chunks than
  // the task had sub-asks — so `perPage` above 3 was silently a no-op, and the
  // carrier paragraph stayed unreachable at every setting.
  const perAsk = new Map()
  const chunks = new Map()
  for (const i of idx.live) {
    const row = idx.meta.rows[i]
    if (row.path === INDEX_MD) continue
    const w = weightOf(row.path)
    if (!w) continue // weight 0 = exclusion, the same one code path as the keyword leg
    let arr = perAsk.get(row.path)
    if (!arr) {
      perAsk.set(row.path, (arr = new Float64Array(n).fill(-1)))
      chunks.set(row.path, [])
    }
    let sMax = -1
    for (let a = 0; a < n; a++) {
      const qv = qvs[a]
      let s = 0
      for (let j = 0; j < d; j++) s += qv[j] * idx.vecs[i * d + j]
      if (s * w > arr[a]) arr[a] = s * w
      if (s > sMax) sMax = s
    }
    chunks.get(row.path).push({ score: sMax, row })
  }

  // path → { adj, sim }: the toll-adjusted score that CHOOSES the page and
  // orders the emission, kept apart from the true cosine that is reported.
  const chosen = new Map()
  for (let a = 0; a < n; a++)
    for (const { path, s } of [...perAsk.entries()]
      .map(([path, arr]) => ({ path, s: arr[a] }))
      .sort((x, y) => y.s - x.s)
      .slice(0, perAskPages))
      chosen.set(path, { adj: Math.max(chosen.get(path)?.adj ?? -1, s), sim: Math.max(chosen.get(path)?.sim ?? -1, s / weightOf(path)) })

  /* ⚠️ Emitted BY SIMILARITY ACROSS PAGES, not page by page — the caller renders
   * rows top-down until a byte budget is spent, so emission ORDER is what it
   * actually gets. Grouped by page, a 5 KB section was the top page's chunks and
   * nothing else. Both alternatives were measured on the fixture (how often the
   * fact-carrying paragraph renders inside 5.2 KB): flat similarity 2/13,
   * round-robin over pages 1/13, page-grouped 1/13. Depth-first is the right
   * order for a reader who can scroll and the wrong one for a budget that stops. */
  const byPage = []
  for (const [p, score] of [...chosen.entries()].sort((x, y) => y[1].adj - x[1].adj)) {
    const body = pageBody(root, p)
    if (body == null) continue
    byPage.push(
      chunks
        .get(p)
        .sort((x, y) => y.score - x.score)
        .slice(0, perPage)
        // The chunk's own text, sliced live at the range the indexer recorded —
        // meta.json holds row headers, not chunk bodies.
        .map(({ score: s, row }) => ({
          path: p,
          title: row.title,
          section: row.crumb || '',
          similarity: Number(s.toFixed(4)),
          pageScore: Number(score.sim.toFixed(4)),
          // The LABEL is membership, not the weight: at weight 1 a closed page
          // still has to be presented as closed, or the block reads as live work.
          ...(closedPaths?.has(p) ? { closed: true } : {}),
          text: body
            .slice(row.start ?? 0, row.end ?? body.length)
            .trim()
            .replace(/\s+/g, ' '),
        }))
        .filter((r) => r.text),
    )
  }
  // Ordered by the ADJUSTED score — the caller renders top-down until its byte
  // budget is spent, so emission order is where the toll actually lands.
  return byPage.flat().sort((a, b) => b.similarity * weightOf(b.path) - a.similarity * weightOf(a.path))
}

/**
 * The dense leg for one spawn task — core's `semanticCandidates` contract.
 *
 * → { available, reason?, rows: [{ path, title, section, similarity, pageScore,
 *     closed?, text }], pages, asks, ms, index? }
 *
 * `closedPaths` (a Set of vault-relative paths) + `doneWeight` are the status
 * half: the caller already walks the tree for its keyword pass, so this leg is
 * told which pages are closed rather than reading them again.
 *
 * NEVER throws and never returns a partial failure the caller has to interpret:
 * anything wrong — no index, no encoder, a cold load that overruns, a hung
 * embed — comes back `available:false` with a reason for the audit line, and the
 * caller renders no section at all.
 */
export async function semanticCandidates({ asks, root, perAskPages = PER_ASK_PAGES, perPage = PER_PAGE, deadlineMs = DEADLINE_MS, enabled = EVIDENCE_SEMANTIC_ENABLED, closedPaths, doneWeight = 1 } = {}) {
  const t0 = Date.now()
  // `enabled` follows the env opt-in by default, and is a parameter so a harness
  // can score keyword-only and keyword+semantic in ONE process against ONE
  // loaded index — two runs would be two different vault states.
  if (!enabled) return { available: false, reason: 'disabled (ATLAS_EVIDENCE_SEMANTIC not set)', rows: [], pages: 0, asks: 0, ms: 0 }
  const list = (asks || []).filter((a) => a && a.trim())
  if (!list.length || !root) return { available: false, reason: 'no asks', rows: [], pages: 0, asks: 0, ms: 0 }
  // Checked BEFORE the deadline is armed and before any await: on a machine with
  // no encoder or no index this costs one stat() and the spawn path is untouched.
  const status = semanticStatus(root)
  if (!status.available) return { available: false, reason: status.reason, rows: [], pages: 0, asks: 0, ms: Date.now() - t0 }

  const run = (async () => {
    const idx = loadIndex(root)
    if (idx.error) return { error: idx.error }
    const ctx = await resident()
    const { vectors } = await embed(ctx, list.map(QUERY_PROMPT), { dims: idx.meta.dims })
    return { rows: scan(idx, vectors, root, { perAskPages, perPage, closedPaths, doneWeight }) }
  })().catch((e) => ({ error: String(e?.message || e) }))

  const verdict = await Promise.race([run, deadline(deadlineMs)])
  const ms = Date.now() - t0
  if (verdict === 'deadline') return { available: false, reason: `semantic leg exceeded ${deadlineMs} ms`, rows: [], pages: 0, asks: list.length, ms }
  if (verdict.error) return { available: false, reason: verdict.error, rows: [], pages: 0, asks: list.length, ms }
  return {
    available: true,
    // ⚠️ The score TRAVELS WITH THE ROW. The vector leg cannot return nothing
    // (cosine to every chunk is never empty), so a top score of 0.31 means
    // "nothing close" — and only a reader who can see the number can say so.
    rows: verdict.rows,
    pages: new Set(verdict.rows.map((r) => r.path)).size,
    asks: list.length,
    ms,
    index: status.index,
  }
}
