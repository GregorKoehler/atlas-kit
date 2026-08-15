# `instagram-ingest`

File **one** Instagram post or reel into your vault as a `Wiki/Sources/` page: the caption
verbatim, the stills, a short analysis written by `claude -p`, and the source URL — committed
through the vault's serial commit queue like every other write.

Optional, off by default. Enable it with `ATLAS_ADDONS=instagram-ingest` (or `addons.json`);
with it disabled the kit is byte-identical to one that never had it (see
[docs/ADDONS.md](../../docs/ADDONS.md)).

## What it costs

| | |
|---|---|
| disk | `yt-dlp` (~30 MB out of tree if this script installs it), plus the stills it stores — capped at 6 images / 5 MB each per post, committed into the vault's git history **permanently** |
| network | two `yt-dlp` calls per ingest, to Instagram, as you |
| money | none directly — the analysis runs on your Claude **subscription** via `claude -p`, never an API key |
| time | seconds for the fetch, up to ~3 min for the analysis |

## What it deliberately does not do

- **No video download.** A reel's cover frame and a photo post's images are what the vision
  model can actually read; a 60 MB mp4 in a git-backed vault is a permanent cost with no
  reader. You get the stills and the caption, not the footage.
- **No bulk, no crawl, no schedule.** One URL per call, one ingest at a time, no cron entry.
  A profile, hashtag, `/explore/` or `/stories/` URL is refused outright.
- **No login, no scraping around the wall.** It drives `yt-dlp` with **your own** session and
  goes no further than that session already goes.

---

## 1. Install

```bash
bash addons/instagram-ingest/install.sh          # yt-dlp + the skill link + a config stub
bash addons/instagram-ingest/install.sh --check  # 0 installed · 2 installable · 1 cannot
```

It installs `yt-dlp` (pipx → pip --user → standalone binary), links the Claude Code skill into
`.claude/skills/instagram-ingest`, and writes an `.env` snippet to
`~/.atlas-kit/instagram-ingest.env.sample`. It never touches your cookies — that part is
yours, and it is the next section.

## 2. Your own cookies

Instagram serves a **login wall** to logged-out clients for essentially every post, so without
cookies this addon works only on the few posts that happen to render publicly. Cookies are how
`yt-dlp` acts as *you*, on posts *you* can already see. Pick one of two ways.

### Option A — export a `cookies.txt`

Use a Netscape-format cookie-export browser extension (e.g. "Get cookies.txt LOCALLY" for
Chrome/Firefox — pick an open-source one and check what it does before you install it), log
into Instagram in that browser, export **only** the `instagram.com` cookies, and put the file
somewhere **outside this repo**:

```bash
mkdir -p ~/.atlas-kit && chmod 700 ~/.atlas-kit
mv ~/Downloads/instagram.com_cookies.txt ~/.atlas-kit/instagram-cookies.txt
chmod 600 ~/.atlas-kit/instagram-cookies.txt
```

```bash
# .env
ATLAS_IG_COOKIES_FILE=/home/you/.atlas-kit/instagram-cookies.txt
```

This is the right option when the box that runs Atlas Kit is **not** the machine you browse on
— export on your laptop, copy the file across (`scp`, not a chat window).

### Option B — read the browser profile directly

If Atlas Kit runs on the same machine you browse on, skip the file:

```bash
# .env — BROWSER[+KEYRING][:PROFILE], exactly as yt-dlp takes it
ATLAS_IG_COOKIES_BROWSER=firefox
```

`yt-dlp` reads the profile on disk. On Chrome/Chromium this needs the browser's keyring to be
unlocked and usually **the browser closed**; Firefox is generally the easier one on a server.

If both are set, the **file wins** and the ingest says so in its warnings.

### ⚠️ Read this before you export anything

- **A cookie jar is a live login session.** Anyone who gets the file can act as you on
  Instagram without a password and without your 2FA. Treat it exactly like a password.
- **Never commit it.** Not to this repo, not to your vault, not to a gist, not into a prompt.
  Keep it outside the repo tree entirely — `.env` and `~/.atlas-kit/` are gitignored /
  outside; a path inside `addons/` is not a safe place for it.
- **`chmod 600`.** Other users on the box can otherwise read it.
- **They expire.** Logging out, changing your password, or Instagram's own session rotation
  invalidates them — the first symptom is every ingest failing with a login error. Re-export.
- **Your own account, posts you can access.** This is for filing things you can already open.
  Do not use someone else's session, and do not use it to reach content your account cannot.
- **Personal use, at human pace.** Instagram rate-limits, and automated access is against
  their terms; one post at a time is both the design and the limit you should keep. Repeated
  failures in a short window mean you are being throttled — stop, do not retry in a loop.
- **The content is not yours.** The page you get is a private note in your own vault. Anything
  further — republishing, redistribution — is a copyright question this addon does not answer.

## 3. Configure

```bash
# .env
ATLAS_ADDONS=instagram-ingest             # enable the addon
ATLAS_IG_COOKIES_FILE=/…/cookies.txt      # …or ATLAS_IG_COOKIES_BROWSER=firefox
# ATLAS_IG_YTDLP=/root/.atlas-kit/bin/yt-dlp   # only if yt-dlp is off the service PATH
# ATLAS_IG_MODEL=claude-sonnet-5          # the vision model that reads caption + stills
# ATLAS_IG_EFFORT=low                     # thinking bound; empty string omits the flag
# ATLAS_IG_VAULT=atlas                    # which vault the page lands in (default: the default)
# ATLAS_IG_MAX_IMAGES=6                   # per post; the vault is git, blobs are permanent
# ATLAS_IG_MAX_IMAGE_BYTES=5242880
# ATLAS_IG_MAX_CAPTION_CHARS=20000
# ATLAS_IG_MAX_RECORDS=200                # ingest-log cap
# ATLAS_IG_META_TIMEOUT_MS=30000 · ATLAS_IG_MEDIA_TIMEOUT_MS=120000 · ATLAS_IG_ANALYSIS_TIMEOUT_MS=180000
```

Then `scripts/serve.sh restart` — enabling an addon is a restart, not a reload.

## 4. Use it

```bash
curl -s -X POST http://127.0.0.1:3001/api/ingest/instagram \
  -H "Authorization: Bearer $DASHBOARD_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.instagram.com/p/<code>/"}'
```

or, without the API:

```bash
node --env-file=.env addons/instagram-ingest/scripts/ingest.mjs 'https://www.instagram.com/reel/<code>/'
```

or ask a Claude Code agent — `install.sh` links the **`instagram-ingest` skill**, which
validates the URL, calls the endpoint, verifies the page and triages the failure for you.

`GET /api/ingest/instagram/records?limit=50` lists what has been ingested, newest first,
successes **and** failures with their reasons. `GET /api/addons` reports whether `yt-dlp`
resolved and which cookie mode is configured.

## 5. What lands in the vault

```
Wiki/Sources/instagram-<code>.md        the page  (type: source, source: instagram, url, created, tags)
Wiki/assets/instagram/<code>/1.jpg …    the stills, bounded
```

The page carries, in this order: the model's title and read of the post, the **caption
verbatim** in its own blockquoted section, the images, the source URL, and — when something
went wrong — a warning callout naming it. The slug comes from the post code, so re-ingesting
the same post updates one page instead of accumulating near-duplicates.

## 6. When it fails

Failures are loud by construction: an actionable message in the HTTP answer, a line on stderr,
and a record in the ingest log. The common ones:

| symptom | what it means |
|---|---|
| `not a single Instagram post URL` (400) | a profile/hashtag/story URL — not ingestible |
| `an ingest is already running` (409) | one at a time, by design; retry in a minute |
| `ATLAS_IG_COOKIES_FILE points at … which does not exist` (500) | the path is wrong or the export was moved — it refuses rather than silently running cookie-less |
| `Instagram refused the request` (502) | no cookies → configure them. Cookies configured → they most likely **expired**; it also covers a private, deleted or geo-blocked post, which Instagram does not distinguish from out here |
| `no images fetched` (warning, page still written) | usually the same wall, sometimes a post type yt-dlp cannot see stills for |
| `no analysis` (warning, page still written) | `claude` missing, not logged in, or it returned an unusable answer twice — the caption is still there |
| `vault commit failed` (500) | the vault write failed; the staged files are removed, so the vault is left clean |

## 7. Turning it off

Remove `instagram-ingest` from `ATLAS_ADDONS` / `addons.json` and restart. The code stays on
disk and stops being imported; the pages it wrote are ordinary vault notes and stay. To also
drop the skill link: `rm .claude/skills/instagram-ingest`. **Delete your cookie file** when
you stop using it, and log out of that browser session to invalidate it.
