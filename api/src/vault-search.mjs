/* ------------------------------------------------------------------ *
 * Ranking core for the vault full-text search — the engine behind
 * `GET /api/search`, the MCP `query_vault` tool, the bridge `atlas-query`
 * relay and the dashboard's search box.
 *
 * WHAT IT REPLACES. `search()` used to lowercase the WHOLE query and ask
 * `title.includes(query) || body.includes(query)`, scoring hits with four
 * constants. So `3d scene` returned hits and `scene 3d` returned NONE — same
 * words, reversed — and most realistic multi-word queries answered with an
 * empty list. That is the failure that matters: an empty result is
 * indistinguishable from "the vault does not know this", so an agent
 * re-decides a settled question instead of reading the page that settled it.
 *
 * RELEVANCE, NOT SPEED. Searching a whole vault costs ~90 ms over ~1500 pages;
 * a single model turn costs seconds. Retrieval is a few percent of the cost of
 * the turn it feeds, so there is nothing here to optimise: no cache, no index,
 * no daemon. Spending more milliseconds to return the RIGHT 20 KB is always the
 * trade to take.
 *
 * THE MODEL. BM25F over three fields (body, title, path) with one document
 * length normalisation on the body:
 *
 *   - TERM frequency, so a page that says "cloudflare" nine times beats one
 *     that mentions it once;
 *   - DOCUMENT frequency, so the rare term in "cloudflare tunnel setup" decides
 *     the ranking and the two common ones only break ties;
 *   - LENGTH normalisation, which is what keeps `Wiki/log.md` (often the
 *     largest file in a vault, and it contains literally every term) from
 *     winning every query it appears in. Not zero: it is still legitimately
 *     searchable, it is simply no longer a free winner.
 *
 * The two signals the old scorer had are kept as weights rather than discarded:
 * a title/path hit outranks a body hit (W_TITLE/W_PATH), and `Wiki/` outranks
 * loose notes (WIKI_BOOST).
 *
 * NON-ENGLISH PROSE. A vault is routinely mixed-language, so: tokenisation is
 * Unicode-aware (ä/ö/ü/ß and friends are letters, not separators) and
 * lowercasing is plain `toLowerCase`, which handles them. There is NO stemmer —
 * an English stemmer over German text is worse than none, and a per-language one
 * is a dependency this does not need. What compounding languages actually need
 * is PREFIXES: `Nebenkosten` is a prefix of `Nebenkostenabrechnung`, and the old
 * substring search matched that by accident where exact-token matching would
 * not. So a query term that matches no token exactly may match tokens it
 * PREFIXES, at a discount (PREFIX_WEIGHT).
 *
 * ⚠️ Prefix matching is a RECALL trade — it rescues queries that would otherwise
 * miss entirely, at the cost of a page or two slipping a rank. Kept because a
 * page that is never returned is the failure this whole file exists to end,
 * while a page at rank 2 instead of rank 1 is not. Turning it off is one
 * constant (PREFIX_MIN).
 *
 * QUOTES. `"…"` is an exact-phrase clause and is REQUIRED — that is the old
 * substring behaviour, kept reachable on purpose rather than deleted.
 * Unquoted terms are OR: a page matching three of four terms still ranks.
 *
 * Pure apart from being handed documents, so it is unit-testable against a
 * fixture vault (api/test/vault-search.test.mjs).
 * ------------------------------------------------------------------ */

// BM25's two standard knobs, both moved off the textbook defaults (1.2 / 0.75)
// for the same reason: a vault's documents differ in size by THREE orders of
// magnitude — a 300-byte task note and a project page that is really a book of
// sections — which is the assumption BM25's normalisation is least comfortable
// with.
//   K1 = term-frequency saturation. Raised, so a page that says "cloudflare" 25
//     times is allowed to actually beat one that says it twice.
//   B  = how hard length normalisation bites. Eased, because at 0.75 the
//     most-synthesised pages (the big project pages) were unfindable.
// ⚠️ Neighbouring settings differ by one or two queries out of a few dozen, i.e.
// inside the noise: this is a defensible choice, not a tuned optimum, and the
// textbook defaults would also have been fine.
const K1 = 2.5
const B = 0.6
// A term in the title or the path is evidence ABOUT the page, not just evidence
// IN it — `Tasks/rotate-the-api-keys-….md` is what the query "rotate api keys"
// is looking for. Counted as many body occurrences rather than as a flat bonus,
// so saturation and length normalisation still apply to it.
const W_TITLE = 8
const W_PATH = 5
// Wiki/ is synthesis, everything else (Tasks/, Inbox/, raw/) is raw or
// operational. A nudge, NOT a tier: at 1.15 a Tasks/ note that is genuinely
// about the query still beats a Wiki/ page that merely mentions it — which is
// most of what an agent asks for.
const WIKI_BOOST = 1.15
// Compounding. Only for terms long enough to be meaningful (a 3-letter prefix
// matches half the vault) and only when the term matches NO token exactly, so an
// exact match is never diluted by its own prefix matches.
const PREFIX_MIN = 4
const PREFIX_WEIGHT = 0.35

const TOKEN_RE = /[\p{L}\p{N}]+/gu

/** Lowercased word tokens. Unicode-aware: `Prüfprozess` is one token, `for_project`
 *  is two (which is what makes a query for one half of a snake_case key work). */
export function tokenize(text) {
  return String(text || '').toLowerCase().match(TOKEN_RE) || []
}

/**
 * Split a query into clauses. `"…"` → a required exact-phrase clause (the old
 * substring behaviour); everything else → optional terms.
 * Returns [{ kind: 'term'|'phrase', text }].
 */
export function parseQuery(q) {
  const raw = String(q || '')
  const clauses = []
  const seen = new Set()
  const push = (kind, text) => {
    const key = kind + ':' + text
    if (text && !seen.has(key)) (seen.add(key), clauses.push({ kind, text }))
  }
  // Pull the quoted spans out first, then tokenise what is left over.
  const rest = raw.replace(/"([^"]+)"/g, (_m, phrase) => {
    push('phrase', phrase.trim().toLowerCase())
    return ' '
  })
  for (const t of tokenize(rest)) push('term', t)
  return clauses
}

// Occurrences of `needle` in `hay` (both lowercased). Overlapping matches don't
// arise for real phrases, so a simple forward scan is enough.
function countPhrase(hay, needle) {
  let n = 0
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++
  return n
}

// tf of one clause in one tokenised field. Exact hits win outright; a term that
// hits nothing falls back to the tokens it prefixes (compounds).
function fieldTf(clause, counts, lowerText) {
  if (clause.kind === 'phrase') return countPhrase(lowerText, clause.text)
  const exact = counts.get(clause.text) || 0
  if (exact || clause.text.length < PREFIX_MIN) return exact
  let n = 0
  for (const [tok, c] of counts) if (tok.length > clause.text.length && tok.startsWith(clause.text)) n += c
  return n * PREFIX_WEIGHT
}

function counted(tokens) {
  const m = new Map()
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1)
  return m
}

/**
 * Does a document satisfy EVERY clause? The AND counterpart of the OR scoring
 * below, for the caller that FILTERS instead of ranking: `query_atlas`'s hybrid
 * `text` leg, where a row is either in the exact answer or not in it at all.
 *
 * Deliberately the SAME matching rule as the scorer — a term hits an exact
 * token or, failing that, a token it prefixes (compounding); a quoted phrase
 * hits a contiguous substring — so the two surfaces can never disagree about
 * what the word "matches" means. Only the combinator differs, and that
 * difference is a semantic choice, not an implementation one: a search RANKS
 * partial matches, a filter must not silently widen the set it claims is exact.
 */
export function matchesAll(clauses, text) {
  if (!clauses.length) return true
  const lower = String(text || '').toLowerCase()
  // Every way a clause can match — exact token, the token it prefixes, a phrase
  // — implies the clause is at minimum a SUBSTRING of the text. So this is a
  // necessary condition, and it rejects the great majority of pages without
  // tokenising them at all: measured over a ~1450-page vault it roughly halves
  // the filter's cost, returning the identical rows.
  if (!clauses.every((c) => lower.includes(c.text))) return false
  const counts = counted(tokenize(lower))
  return clauses.every((c) => fieldTf(c, counts, lower) > 0)
}

/**
 * Two-phase scorer: `add()` every document (keeping only its per-clause tf and
 * length, never its text — a vault tree is many MB and this runs on a RAM-bound
 * box), then `rank()` once document frequencies are known.
 *
 * add(doc): { id, title, path, body, isWiki }. rank(): [{ id, score }], best first.
 */
export function createScorer(query) {
  const clauses = parseQuery(query)
  const df = clauses.map(() => 0)
  const docs = []
  let totalLen = 0

  return {
    clauses,
    add(doc) {
      if (!clauses.length) return
      const bodyTokens = tokenize(doc.body)
      const body = counted(bodyTokens)
      const title = counted(tokenize(doc.title))
      const pathTokens = counted(tokenize(doc.path))
      const lowerBody = String(doc.body || '').toLowerCase()
      const lowerTitle = String(doc.title || '').toLowerCase()
      const lowerPath = String(doc.path || '').toLowerCase()
      const tf = clauses.map(
        (c) =>
          fieldTf(c, body, lowerBody) + W_TITLE * fieldTf(c, title, lowerTitle) + W_PATH * fieldTf(c, pathTokens, lowerPath),
      )
      if (!tf.some((x) => x > 0)) return
      // A quoted phrase is a filter, not a hint: a page without it is not a hit.
      if (clauses.some((c, i) => c.kind === 'phrase' && tf[i] <= 0)) return
      tf.forEach((x, i) => x > 0 && df[i]++)
      docs.push({ id: doc.id, tf, len: bodyTokens.length, isWiki: !!doc.isWiki })
      totalLen += bodyTokens.length
    },
    rank() {
      if (!docs.length) return []
      const n = docs.length
      const avgLen = totalLen / n || 1
      // Probabilistic IDF over the MATCHED set. `+1` inside the log keeps it
      // positive for a term that is in every matched document — such a term
      // then just carries no signal, instead of scoring negative and actively
      // demoting the pages that contain it.
      const idf = df.map((d) => Math.log(1 + (n - d + 0.5) / (d + 0.5)))
      return docs
        .map((d) => {
          const norm = K1 * (1 - B + (B * d.len) / avgLen)
          let score = 0
          for (let i = 0; i < d.tf.length; i++) if (d.tf[i] > 0) score += idf[i] * ((d.tf[i] * (K1 + 1)) / (d.tf[i] + norm))
          return { id: d.id, score: score * (d.isWiki ? WIKI_BOOST : 1) }
        })
        .filter((d) => d.score > 0)
        .sort((a, b) => b.score - a.score)
    },
  }
}

// Snippet window. The old `snippetFor` could only find the whole query as one
// substring, so once matching is per-term it would have returned '' for every
// multi-term hit — the exact case this search now exists to serve.
const SNIPPET_BEFORE = 60
const SNIPPET_AFTER = 120
const NEAR = 90 // how far from the anchor another clause still counts as "in context"
const OCCURRENCES = 12 // per clause; enough to find a good window without scanning a huge page

/**
 * A snippet centred on the passage where the MOST distinct clauses co-occur —
 * not on the first occurrence of the first term, which on a large page is
 * routinely an unrelated paragraph.
 */
export function snippet(body, clauses) {
  const lower = String(body || '').toLowerCase()
  if (!lower || !clauses.length) return ''
  const positions = []
  for (const c of clauses) {
    for (let i = lower.indexOf(c.text), k = 0; i !== -1 && k < OCCURRENCES; i = lower.indexOf(c.text, i + c.text.length), k++) {
      positions.push({ at: i, len: c.text.length })
    }
  }
  if (!positions.length) return ''
  let best = positions[0]
  let bestScore = -1
  for (const p of positions) {
    let score = 0
    for (const c of clauses) {
      const from = Math.max(0, p.at - NEAR)
      if (lower.slice(from, p.at + p.len + NEAR).includes(c.text)) score++
    }
    if (score > bestScore) (bestScore = score), (best = p)
  }
  const start = Math.max(0, best.at - SNIPPET_BEFORE)
  const end = Math.min(body.length, best.at + best.len + SNIPPET_AFTER)
  return (start > 0 ? '…' : '') + body.slice(start, end).replace(/\s+/g, ' ').trim() + (end < body.length ? '…' : '')
}
