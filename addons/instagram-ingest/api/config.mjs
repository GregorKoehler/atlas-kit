/* ------------------------------------------------------------------ *
 * Every knob `addons/instagram-ingest` reads, in one place.
 *
 * Read at CALL time, never frozen at import. `register()` imports this module at
 * boot, so a value captured in a top-level `const` would pin whatever `.env` said
 * at process start and quietly ignore the operator's next edit — and the tests
 * would have to re-import the module per case to vary one string.
 *
 * ⚠️ THE COOKIE PATH IS THE ONE KNOB THAT MATTERS. Instagram serves a login wall
 * to logged-out clients for essentially every post, so without cookies this addon
 * works only on the handful of posts that happen to render publicly. Both forms
 * are supported and neither is stored here: a `cookies.txt` YOU exported (kept
 * outside the repo) or `--cookies-from-browser`, reading YOUR OWN browser profile
 * on this machine. See ../README.md for how to export one safely.
 * ------------------------------------------------------------------ */
import os from 'node:os'
import path from 'node:path'

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

/** The ingest log. Outside the vault: it is dashboard bookkeeping, not knowledge. */
export const recordsFile = () => str('ATLAS_IG_RECORDS_FILE', path.join(stateDir(), 'instagram-ingest.json'))

/** yt-dlp, overridable because a pipx/venv install is often off the service PATH. */
export const ytdlpBin = () => str('ATLAS_IG_YTDLP', 'yt-dlp')

/** `{ file, browser }` — the user's own session, one form or the other. */
export const cookieConfig = () => ({
  file: str('ATLAS_IG_COOKIES_FILE'),
  browser: str('ATLAS_IG_COOKIES_BROWSER'),
})

/** The vision model that reads the caption + stills. Empty key → subscription auth. */
export const model = () => str('ATLAS_IG_MODEL', 'claude-sonnet-5')

/* An explicit thinking bound, per the kit's claude -p convention: Sonnet 5 runs
 * adaptive thinking when `--effort` is omitted, which is the wrong default for a
 * headless one-shot. `ATLAS_IG_EFFORT=` (empty) is a deliberate opt-out and omits
 * the flag entirely — hence `??`, not `||`. */
export const effort = () => process.env.ATLAS_IG_EFFORT ?? 'low'

export const timeouts = () => ({
  meta: num('ATLAS_IG_META_TIMEOUT_MS', 30000), // a metadata probe that hangs is a hung route
  media: num('ATLAS_IG_MEDIA_TIMEOUT_MS', 120000),
  analysis: num('ATLAS_IG_ANALYSIS_TIMEOUT_MS', 180000),
})

/* Bounded assets. The vault is a git repo — a blob committed once is in the
 * history forever — so a carousel with 20 slides stores the first few and says
 * so on the page rather than growing the clone silently. */
export const limits = () => ({
  images: num('ATLAS_IG_MAX_IMAGES', 6),
  imageBytes: num('ATLAS_IG_MAX_IMAGE_BYTES', 5 * 1024 * 1024),
  captionChars: num('ATLAS_IG_MAX_CAPTION_CHARS', 20000),
  records: num('ATLAS_IG_MAX_RECORDS', 200),
})

/** Which vault the Source page is written to. Unset → the registry's default. */
export const vaultKey = () => str('ATLAS_IG_VAULT') || undefined
