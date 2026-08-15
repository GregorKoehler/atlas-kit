/* ------------------------------------------------------------------ *
 * Every knob `addons/news-ingest` reads, in one place.
 *
 * Read at CALL time, never frozen at import — `register()` imports this module
 * at boot, so a value captured in a top-level `const` would pin whatever `.env`
 * said at process start and quietly ignore the operator's next edit.
 *
 * 🔴 THE CAPS ARE THE COST CONTROL. Every NEW item costs one `claude -p` call, so
 * a run's spend is bounded by `maxItems` and nothing else: a feed that dumps 200
 * entries after an outage, or a first sweep against a freshly configured feed
 * list, must cost the same as a quiet hour. The backlog drains over the following
 * runs instead of arriving as one bill.
 * ------------------------------------------------------------------ */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ADDON_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const str = (k, d = '') => {
  const v = process.env[k]
  return v === undefined || v === '' ? d : v
}
const num = (k, d) => {
  const n = Number(process.env[k])
  return Number.isFinite(n) && n > 0 ? n : d
}

/** Where operator-local state lives — the same dir the agent runtime uses. */
export const stateDir = () => str('AGENT_LOCAL_DIR', path.join(os.homedir(), '.atlas-kit'))

/** The feed list. Gitignored — `feeds.example.json` is what ships. */
export const feedsFile = () => str('ATLAS_NEWS_FEEDS_FILE', path.join(ADDON_DIR, 'feeds.json'))

/** Seen-state + run log. Outside the vault: it is bookkeeping, not knowledge. */
export const stateFile = () => str('ATLAS_NEWS_STATE_FILE', path.join(stateDir(), 'news-ingest.json'))

/** The model that writes the per-item summary. Empty key → subscription auth. */
export const model = () => str('ATLAS_NEWS_MODEL', 'claude-sonnet-5')

/* An explicit thinking bound, per the kit's claude -p convention: Sonnet 5 runs
 * adaptive thinking when `--effort` is omitted, which is the wrong default for a
 * headless one-shot. `ATLAS_NEWS_EFFORT=` (empty) is a deliberate opt-out and
 * omits the flag entirely — hence `??`, not `||`. */
export const effort = () => process.env.ATLAS_NEWS_EFFORT ?? 'low'

export const timeouts = () => ({
  fetch: num('ATLAS_NEWS_FETCH_TIMEOUT_MS', 20000), // a feed that hangs must not hang the run
  summary: num('ATLAS_NEWS_SUMMARY_TIMEOUT_MS', 120000),
})

export const limits = () => ({
  items: num('ATLAS_NEWS_MAX_ITEMS', 12), // per RUN, across all feeds — the spend bound
  perFeed: num('ATLAS_NEWS_MAX_PER_FEED', 5), // so one loud feed cannot eat the whole run
  excerptChars: num('ATLAS_NEWS_MAX_EXCERPT_CHARS', 4000), // per item, into the prompt and the page
  feedBytes: num('ATLAS_NEWS_MAX_FEED_BYTES', 4 * 1024 * 1024), // a feed body is text; anything larger is a mistake
  digestItems: num('ATLAS_NEWS_DIGEST_ITEMS', 40), // rows on the rolling digest page
  seen: num('ATLAS_NEWS_MAX_SEEN', 2000), // dedupe memory; feeds carry tens of items, not thousands
  runs: num('ATLAS_NEWS_MAX_RUNS', 30), // run log depth
})

/** The rolling digest page — live state, overwritten every run. */
export const digestPage = () => str('ATLAS_NEWS_DIGEST_PAGE', 'Wiki/News-Digest.md')

/** Which vault the pages land in. Unset → the registry's default. */
export const vaultKey = () => str('ATLAS_NEWS_VAULT') || undefined
