/* ------------------------------------------------------------------ *
 * The SEAM for the optional dense (vector) retrieval leg of the spawn-time
 * evidence block — present here, off in core.
 *
 * `atlas-candidates.mjs` retrieves with two instruments the kit ships: a
 * full-text pass over the tree and the typed `queryAtlas()` engine. A THIRD,
 * dense leg — the task decomposed into sub-asks, embedded, and pooled at CHUNK
 * level so what comes back is a passage rather than a page — is what reaches the
 * one thing neither of those structurally can: a fact whose only handle is a
 * word the task never used. It needs an embedding model and an index, which is a
 * different class of dependency from "read markdown off disk", so it ships as an
 * OPTIONAL ADDON rather than in core.
 *
 * This module is the whole interface between the two. Core calls `subAsks()` and
 * `semanticCandidates()` unconditionally and renders a semantic section whenever
 * rows come back; with no addon installed the leg reports itself UNAVAILABLE,
 * no section is emitted, and the block is byte-identical to a kit that never had
 * the hook. Installing the addon means replacing this module's implementation —
 * `atlas-candidates.mjs` does not change.
 *
 * 🔴 The legs are UNIONED, NEVER FUSED — see the header of atlas-candidates.mjs.
 * Whatever supplies `semanticCandidates` must keep its own ranking and its own
 * section; merging the lists (RRF or otherwise) is measured to make retrieval
 * worse, not better.
 *
 * The contract, so an addon can satisfy it without reading core:
 *   subAsks(task)          → [string, …]   the task split into sub-asks
 *   semanticCandidates({ asks, root, enabled, closedPaths, doneWeight })
 *                          → { available, reason?, rows, pages, ms, index? }
 *     rows: [{ path, title, section?, text, similarity, pageScore, closed }]
 *           best first; `text` is a WHOLE chunk, `closed` marks a done task
 *           (core charges it the same DONE_WEIGHT toll the keyword leg does).
 * ------------------------------------------------------------------ */

// Off unless a leg is actually installed AND switched on. Read at import so a
// spawn never pays for a lookup that cannot succeed.
export const EVIDENCE_SEMANTIC_ENABLED = process.env.ATLAS_EVIDENCE_SEMANTIC === '1'

/** One sub-ask: the task as written. A real leg decomposes it (a paragraph-long
 *  dev task asks several things and a single vector averages them into none). */
export function subAsks(task) {
  const t = String(task || '').trim()
  return t ? [t] : []
}

/** The unavailable answer, in the shape core renders. `reason` is surfaced in
 *  the evidence header — "not running" and "ran, found nothing" are different
 *  facts and a reader needs both. */
export async function semanticCandidates({ enabled = EVIDENCE_SEMANTIC_ENABLED } = {}) {
  return {
    available: false,
    reason: enabled ? 'no semantic leg installed — see the semantic-search addon' : 'disabled by default; ATLAS_EVIDENCE_SEMANTIC=1 with the semantic-search addon turns it on',
    rows: [],
    pages: 0,
    ms: 0,
  }
}
