/* ------------------------------------------------------------------ *
 * `addons/semantic-search` — the addon's whole registration surface.
 *
 * Everything this addon adds to a running kit is declared here and nowhere else:
 * a second retrieval leg on `GET /api/search` (and therefore on the MCP
 * `query_vault` tool, which reads that route), the optional dense leg of the
 * spawn-evidence block, a scorecard group for index freshness, and the cron
 * entry that keeps the index swept and the encoder installed.
 *
 * ⚠️ Nothing here touches core. `api/src/atlas-candidates.mjs` — the evidence
 * retriever — does not change when this addon is enabled; it calls the seam in
 * `api/src/atlas-evidence-semantic.mjs`, which delegates to the `evidenceLeg`
 * below. Disable the addon and the seam goes inert again.
 *
 * The modules imported here only DEFINE functions — nothing touches the
 * filesystem, loads the encoder or reads the index until something calls in. So
 * enabling the addon on a box where `install.sh` has never run costs an import
 * and answers `available: false` with a reason, which is the whole
 * degrade-don't-crash contract.
 * ------------------------------------------------------------------ */
import { resolveVault } from '../../../api/src/vaults.mjs'
import { semanticSearch, semanticStatus, indexDirFor } from './semantic.mjs'
import { subAsks, semanticCandidates } from './evidence.mjs'
import { readSweep, sweepStats } from './sweep.mjs'
import { embedRuntimeAvailable, EMBED_DIR, MODEL_ID, DTYPE } from './embed.mjs'

/** Which vault gets indexed and reported on. Unset → the registry's default. */
const semanticVaultPath = () => resolveVault(process.env.ATLAS_SEMANTIC_VAULT || undefined)?.path || null

export default function register() {
  return {
    description: 'Dense (vector) retrieval over the vault — a resident EmbeddingGemma-300M ONNX encoder and a section-chunk index, as a SECOND search leg beside BM25F.',

    /* The second leg of /api/search. It is unioned with the full-text leg and
     * never merged into it — see the header of api/semantic.mjs for the measured
     * reason fusion is refused. */
    searchLeg: { key: 'semantic', label: 'Semantic (vector)', search: semanticSearch },

    /* The dense leg of the SPAWN-EVIDENCE block. Present whenever the addon is
     * enabled, but OFF unless ATLAS_EVIDENCE_SEMANTIC=1 — the gate lives in
     * evidence.mjs, which measured itself flat against keyword-only for +4.5 KB
     * and +709 ms per spawn. Read that header before turning it on. */
    evidenceLeg: { subAsks, semanticCandidates },

    /* Index freshness on the hero Scorecard. Renders NOTHING until a sweep has
     * actually run (see sweepStats) — an addon that is enabled but not yet
     * installed must not paint a permanent row of zeroes. */
    scorecardStats: () => {
      const p = semanticVaultPath()
      return p ? sweepStats(readSweep(indexDirFor(p))) : []
    },

    /* The five-minute sweep. `sweep.sh` heals a missing encoder first (guarded
     * by a persisted backoff) and then re-indexes only what changed — a no-op
     * sweep is ~0.33 s and writes ~150 bytes, so this is cheap enough to run on
     * this cadence and too expensive to run as a write hook: a vault has many
     * independent writers, and phone sync arrives as a `git pull`. */
    cron: [
      {
        schedule: '*/5 * * * *',
        command: 'bash addons/semantic-search/sweep.sh >> /tmp/atlas-kit-addons.log 2>&1',
        comment: 'semantic index sweep + encoder self-heal',
      },
    ],

    /** What `GET /api/addons` reports — enough to tell "installed and current"
     *  from "enabled but never installed" without reading a log. */
    status: () => {
      const p = semanticVaultPath()
      return {
        vault: p,
        encoder: { installed: embedRuntimeAvailable(), dir: EMBED_DIR, model: MODEL_ID, dtype: DTYPE },
        evidenceLeg: process.env.ATLAS_EVIDENCE_SEMANTIC === '1' ? 'on' : 'off (set ATLAS_EVIDENCE_SEMANTIC=1)',
        ...(p ? semanticStatus(p) : { available: false, reason: 'no vault resolved' }),
      }
    },
  }
}
