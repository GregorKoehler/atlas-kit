/* ------------------------------------------------------------------ *
 * The yt-dlp half of the ingest: URL admission, cookies, two bounded calls.
 *
 * TWO CALLS, DELIBERATELY:
 *   1. metadata — `--dump-json --ignore-no-formats-error`. NDJSON, one object per
 *      carousel entry. This is the ONLY source of the caption, and
 *      `--ignore-no-formats-error` is the load-bearing flag: without it a PHOTO
 *      post (no video stream at all) fails outright instead of describing itself.
 *   2. stills — `--skip-download --write-thumbnail`. We never download the video:
 *      a reel's cover frame and a photo post's image are both delivered as
 *      "thumbnails" by yt-dlp, they are what the vision model can actually read,
 *      and a 60 MB mp4 in a git-backed vault is a cost with no reader. So an
 *      image-only post needs no special case — it is the same call, and what
 *      comes back is the actual photo(s) rather than a keyframe of nothing.
 *
 * `--dump-json` implies `--simulate`, which suppresses file writes, so these
 * genuinely cannot be one call. Splitting them also makes each failure
 * separately classifiable, which is the point below: metadata failing is fatal
 * (no caption, no post), stills failing is not (caption-only page, loud warning).
 *
 * ⚠️ ONE URL, ONE POST. `parsePostUrl` admits a single `/p/`, `/reel/` or `/tv/`
 * permalink and nothing else — a profile, a hashtag or an /explore/ URL is
 * refused rather than silently expanded. There is no bulk mode and no crawl; this
 * addon exists to file a link you already opened, on your own account.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ytdlpBin, cookieConfig, timeouts } from './config.mjs'

/* Host match is anchored (`(^|\.)instagram\.com$`) so subdomains work and a
 * lookalike domain does not. Path admits an optional `<user>/` prefix — the
 * share sheet emits both forms — and normalises `/reels/` to `/reel/`. */
const POST_PATH_RE = /^\/(?:[A-Za-z0-9._]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,64})\/?$/

/**
 * `{ kind, code, url }` for a single Instagram post/reel permalink, else null.
 * The returned `url` is CANONICAL: tracking query params (`?igsh=…`) are dropped,
 * so the same post ingested from two share links is one page, not two.
 */
export function parsePostUrl(raw) {
  let u
  try {
    u = new URL(String(raw || '').trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (!/(^|\.)instagram\.com$/i.test(u.hostname)) return null
  const m = POST_PATH_RE.exec(u.pathname)
  if (!m) return null
  const kind = m[1] === 'reels' ? 'reel' : m[1]
  return { kind, code: m[2], url: `https://www.instagram.com/${kind}/${m[2]}/` }
}

/* A browser spec as yt-dlp takes it: BROWSER[+KEYRING][:PROFILE][::CONTAINER].
 * Validated because it is operator input; it never reaches a shell (spawn takes
 * an argv), so this is a typo guard, not an injection guard. */
const BROWSER_RE = /^[a-z]+(\+[A-Za-z]+)?(:[^\s]+)?$/

/**
 * The `--cookies…` argv for YOUR OWN session, plus how it was resolved.
 *
 * 🔴 A CONFIGURED-BUT-MISSING COOKIE FILE THROWS. Falling back to "no cookies"
 * would turn one clear error into every post failing at the login wall with a
 * misleading message — the exact silent rejection this addon is not allowed to
 * have. Nothing configured at all is fine and does NOT throw: public posts
 * sometimes work, and the login-wall hint tells the operator what to do next.
 */
export function cookieArgs(cfg = cookieConfig()) {
  const file = String(cfg.file || '').trim()
  const browser = String(cfg.browser || '').trim()
  if (file) {
    if (!fs.existsSync(file)) {
      throw new Error(
        `ATLAS_IG_COOKIES_FILE points at ${file}, which does not exist — re-export your cookies.txt (see addons/instagram-ingest/README.md)`,
      )
    }
    return {
      args: ['--cookies', file],
      mode: 'file',
      // Stated rather than silently preferred: an operator who set both should
      // know which one actually ran when a post fails.
      warning: browser ? 'both ATLAS_IG_COOKIES_FILE and ATLAS_IG_COOKIES_BROWSER are set — the file wins' : '',
    }
  }
  if (browser) {
    if (!BROWSER_RE.test(browser)) throw new Error(`ATLAS_IG_COOKIES_BROWSER="${browser}" is not a yt-dlp browser spec (e.g. firefox, chrome:Default)`)
    return { args: ['--cookies-from-browser', browser], mode: 'browser', warning: '' }
  }
  return { args: [], mode: 'none', warning: 'no cookies configured — Instagram serves a login wall for most posts' }
}

const COMMON = ['--no-warnings', '-q', '--retries', '3', '--socket-timeout', '20']

/** argv for call 1: metadata only, photo posts included. */
export const metaArgs = (url, cookies = []) => ['--dump-json', '--ignore-no-formats-error', ...COMMON, ...cookies, url]

/** argv for call 2: the stills, into `dir`. Names are yt-dlp's; the vault never
 *  sees them (ingest.mjs renames on copy), so the template only has to be unique
 *  per carousel entry. */
export const mediaArgs = (url, dir, cookies = []) => [
  '--skip-download',
  '--write-thumbnail',
  '--ignore-no-formats-error',
  ...COMMON,
  '-P',
  dir,
  '-o',
  '%(autonumber)03d-%(id)s.%(ext)s',
  ...cookies,
  url,
]

/** Run yt-dlp. Resolves `{ code, stdout, stderr }` — a spawn failure is
 *  `code: null` with the reason in stderr, never a rejection. */
export function runYtdlp(args, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(ytdlpBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ code: null, stdout: '', stderr: `failed to spawn ${ytdlpBin()}: ${e.message}` })
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      stderr += `\n${ytdlpBin()} timed out after ${timeoutMs}ms`
    }, timeoutMs)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: `${stderr}\nfailed to spawn ${ytdlpBin()}: ${e.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/* yt-dlp prints some failures to stdout rather than stderr, so the detail a human
 * reads — and the string classify() matches on — is BOTH streams, merged. */
export const detailOf = ({ stdout = '', stderr = '' }) =>
  [stderr, stdout]
    .map((s) => String(s).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' | ')
    .slice(0, 400)

/* Everything Instagram's login wall looks like from out here. It is one bucket on
 * purpose: an expired cookie, a private post, a rate-limit and a geo-block all
 * arrive as an HTTP error or a "login required" line, and pretending to tell them
 * apart would just make the hint confidently wrong. */
const WALL_RE = /login|log ?in|sign ?in|rate.?limit|429|403|401|private|checkpoint|cookies|not available|unavailable/i

/**
 * A next-step hint for a failed call, or `''` when nothing specific is known.
 * The two hints differ where the operator's next action differs: no cookies
 * configured → configure them; cookies configured → they most likely expired.
 */
export function classifyFailure(detail, cookieMode) {
  if (!WALL_RE.test(String(detail || ''))) return ''
  if (cookieMode === 'none') {
    return 'Instagram refused the request — it serves a login wall to logged-out clients. Configure your own cookies (addons/instagram-ingest/README.md).'
  }
  return 'Instagram refused the request. Your cookies have most likely expired (they are a logged-in session and are invalidated on logout / password change) — re-export them. It can also mean the post is private, deleted, or blocked in this region.'
}

const safeParse = (line) => {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/**
 * The NDJSON of call 1 → the few facts a Source page needs.
 *
 * 🔴 THE CAPTION IS NEVER DROPPED. It is the only part of a post written by a
 * human, it routinely carries what the imagery does not (the recipe, the
 * credit, the link), and on a caption-less-looking reel it is usually the whole
 * point. `description` first, `title` as the fallback, across every entry
 * INCLUDING the playlist wrapper a carousel emits.
 */
export function parseInfo(stdout) {
  const objs = String(stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map(safeParse)
    .filter((o) => o && typeof o === 'object')
  if (!objs.length) return null
  const entries = objs.filter((o) => o._type !== 'playlist')
  const first = (pick) => objs.map(pick).find((v) => typeof v === 'string' && v.trim())
  return {
    caption: (first((o) => o.description) || first((o) => o.title) || '').trim(),
    id: first((o) => o.id) || '',
    uploader: (first((o) => o.uploader) || first((o) => o.uploader_id) || '').replace(/^@/, ''),
    uploadDate: first((o) => o.upload_date) || '', // YYYYMMDD, yt-dlp's own shape
    // "A video really does exist here" — the same negative gate upstream uses to
    // avoid calling a failed video download a photo post.
    hasVideo: entries.some((e) => Array.isArray(e.formats) && e.formats.length > 0),
    entries: entries.length || objs.length,
  }
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp'])

/** The still images call 2 left in `dir`, sorted (yt-dlp's autonumber prefix puts
 *  a carousel back in post order). Directories and non-images are ignored. */
export function collectImages(dir) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => IMAGE_EXT.has(path.extname(n).toLowerCase()))
    .sort()
    .map((n) => path.join(dir, n))
    .filter((p) => {
      try {
        return fs.statSync(p).isFile()
      } catch {
        return false
      }
    })
}

/** Where yt-dlp resolves on this box, or null. A `$PATH` walk with an X_OK
 *  check rather than a spawn: `GET /api/addons` calls this on every poll, and a
 *  status hook that forks a process to answer "is it installed" is a status hook
 *  that gets called less often than it should. */
export function ytdlpPath() {
  const bin = ytdlpBin()
  const candidates = bin.includes('/') ? [path.resolve(bin)] : String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, bin))
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK)
      return c
    } catch {
      /* next */
    }
  }
  return null
}

/** Call 1. Throws with an actionable message — no caption means no page. */
export async function probeMetadata(url, cookies) {
  const t = timeouts()
  const r = await runYtdlp(metaArgs(url, cookies.args), t.meta)
  const detail = detailOf(r)
  if (r.code !== 0) {
    const hint = classifyFailure(detail, cookies.mode)
    throw new Error(`yt-dlp could not read the post${r.code == null ? '' : ` (exit ${r.code})`}: ${detail}${hint ? ` — ${hint}` : ''}`)
  }
  const info = parseInfo(r.stdout)
  if (!info) throw new Error(`yt-dlp returned no metadata for the post: ${detail || 'empty output'}`)
  return info
}

/** Call 2. NEVER throws: a post whose stills we could not fetch still deserves
 *  its caption on a page, so this degrades to `[]` plus a stated warning. */
export async function fetchImages(url, dir, cookies) {
  const t = timeouts()
  const r = await runYtdlp(mediaArgs(url, dir, cookies.args), t.media)
  const files = collectImages(dir)
  if (files.length) return { files, warning: '' }
  const detail = detailOf(r)
  const hint = classifyFailure(detail, cookies.mode)
  return {
    files: [],
    warning: `no images fetched${detail ? `: ${detail}` : ''}${hint ? ` — ${hint}` : ''}`,
  }
}
