# `news-ingest`

Pull **your own** RSS/Atom feeds into the vault on a schedule. Every item you have not seen
becomes a `Wiki/Sources/` page — the feed's text verbatim, a short summary written by
`claude -p`, and the source URL — committed through the vault's serial commit queue like every
other write, plus a rolling `Wiki/News-Digest.md`.

Optional, off by default. Enable it with `ATLAS_ADDONS=news-ingest` (or `addons.json`); with it
disabled the kit is byte-identical to one that never had it (see
[docs/ADDONS.md](../../docs/ADDONS.md)).

## What it costs

| | |
|---|---|
| money | none directly — summaries run on your Claude **subscription** via `claude -p`, never an API key. But this is the one addon that spends it **on a timer**: one call per NEW item, at most `ATLAS_NEWS_MAX_ITEMS` (12) per sweep, hourly → **≤ 288 short calls/day** at the defaults, and far fewer in practice because most hours bring nothing new |
| disk | one markdown page per item, in your vault's git history **permanently** — ~2-6 KB each, so a busy feed list is a few MB a year |
| network | one GET per feed per sweep, bounded to 4 MB and 20 s each |
| time | seconds per feed, plus one model call per new item |
| RAM/CPU | negligible — a cron'd node process that exits |

**The caps are the cost control.** A first sweep against ten fresh feeds does not ingest 400
items: it takes 12, and the backlog drains over the following hours. Lower
`ATLAS_NEWS_MAX_ITEMS` before adding feeds, not after.

## What it deliberately does not do

- **It does not open the articles.** The model sees the headline and the feed's own excerpt,
  and the page says so. Fetching every linked page would make this a crawler, and a summary
  of a page nobody verified was read is worse than an honest excerpt.
- **No filtering, no ranking, no "importance".** Everything new in a feed gets filed, oldest
  cap first. If a feed is too noisy for that, it is the wrong feed for this addon.
- **No feed discovery, no OPML import, no per-item UI triage.** You write the URLs.
- **It never picks your feeds.** `feeds.example.json` ships one neutral placeholder
  (Hacker News' front page) purely to show the file shape.

---

## 1. Install

```bash
bash addons/news-ingest/install.sh          # feeds.json + the skill link + a config stub + cron
bash addons/news-ingest/install.sh --check  # 0 configured · 2 not yet · 1 cannot
```

It seeds `feeds.json` from the example (and never touches it again), links the Claude Code
skill into `.claude/skills/news-ingest`, writes an `.env` snippet to
`~/.atlas-kit/news-ingest.env.sample`, and — as root — regenerates
`/etc/cron.d/atlas-kit-addons` from the enabled addons' declarations.

## 2. Your feeds

`addons/news-ingest/feeds.json` is **gitignored**. An entry is `{url, tag?, title?}`, or a bare
URL string:

```json
{
  "feeds": [
    { "url": "https://example.org/blog/feed.xml", "tag": "example-blog", "title": "Example Blog" },
    "https://example.net/atom.xml"
  ]
}
```

- `tag` — lands in the page's `feed:` frontmatter key and its tags, and groups the digest.
  Defaults to the feed's host.
- `title` — display name. Defaults to the feed's own `<title>`.
- Only `http(s)` URLs are read. RSS 2.0 and Atom both work.

A bad line is **dropped, not fatal**: it comes back in `errors[]` on the sweep and in
`GET /api/addons`, and the other feeds still run. Edits take effect on the **next sweep** — no
restart (only enabling the addon itself is a restart).

> Feeds whose `<description>` is a stub (a bare "Comments" link, a title repeat) produce thin
> pages, because that is genuinely all the feed carried. Prefer feeds that publish a real
> excerpt.

## 3. Configure

```bash
# .env
ATLAS_ADDONS=news-ingest                 # enable the addon
# ATLAS_NEWS_MAX_ITEMS=12                # per sweep, across all feeds — the spend bound
# ATLAS_NEWS_MAX_PER_FEED=5              # so one busy feed cannot eat the run
# ATLAS_NEWS_MODEL=claude-sonnet-5       # the model that writes the summaries
# ATLAS_NEWS_EFFORT=low                  # thinking bound; empty string omits the flag
# ATLAS_NEWS_VAULT=atlas                 # which vault the pages land in (default: the default)
# ATLAS_NEWS_DIGEST_PAGE=Wiki/News-Digest.md
# ATLAS_NEWS_FEEDS_FILE=/path/to/feeds.json      # default: this addon's directory
# ATLAS_NEWS_STATE_FILE=~/.atlas-kit/news-ingest.json
# ATLAS_NEWS_MAX_EXCERPT_CHARS=4000      # per item, into the prompt and the page
# ATLAS_NEWS_MAX_FEED_BYTES=4194304 · ATLAS_NEWS_DIGEST_ITEMS=40 · ATLAS_NEWS_MAX_SEEN=2000
# ATLAS_NEWS_FETCH_TIMEOUT_MS=20000 · ATLAS_NEWS_SUMMARY_TIMEOUT_MS=120000
```

Then `scripts/serve.sh restart` — enabling an addon is a restart, not a reload.

## 4. The schedule

The addon **declares** its cron entry (`api/register.mjs`) and `scripts/addon-cron.mjs`
materialises it into `/etc/cron.d/atlas-kit-addons`:

```
17 * * * *   bash addons/news-ingest/sweep.sh
```

Hourly at :17, offset from the top of the hour. Disabling the addon and re-running
`sudo node scripts/addon-cron.mjs --install` removes the line rather than orphaning it. To
sweep on demand:

```bash
curl -s -X POST http://127.0.0.1:3001/api/news/sweep \
  -H "Authorization: Bearer $DASHBOARD_BEARER_TOKEN"
```

or `node --env-file=.env addons/news-ingest/scripts/sweep.mjs`, or ask a Claude Code agent —
`install.sh` links the **`news-ingest` skill**, which runs the sweep and triages the answer.

## 5. What lands in the vault

```
Wiki/Sources/news-<title-slug>-<key>.md   one page per item
Wiki/News-Digest.md                       the rolling digest — LIVE STATE, rewritten each sweep
```

```yaml
---
type: source
source: news
feed: example-blog
url: "https://example.org/2026/08/a-post"
created: 2026-08-15
published: 2026-08-14
tags: [news, example-blog, …]
---
```

Then the headline as `# `, the model's summary, the feed's text **verbatim** under *From the
feed*, and the source. The digest is a **view**: it is overwritten on every sweep that files
anything, so edit the item pages, never the digest.

`GET /api/news?limit=20` serves the same list to the dashboard's News card (which appears only
when this addon is enabled — `GET /api/addons` is the runtime gate).

## 6. Dedupe, and what happens when things fail

Every ingested item is remembered in `~/.atlas-kit/news-ingest.json` keyed by
`sha1(feed URL + the item's guid/id, else its link)` — feeds re-serve the same entries every
poll, so this file is what stops the sweep from re-summarizing the front page every hour. It is
written **after** the commit lands: a failed commit means nothing was marked seen and the next
sweep retries, instead of dropping items silently.

| symptom | what it means |
|---|---|
| `no feed list at …` | `feeds.json` is missing — run `install.sh` |
| `feeds[2]: … is not a URL` | one line in `feeds.json` is wrong; the other feeds still ran |
| `<tag>: HTTP 429` / `timed out` | that feed's server said no. One feed failing never kills a run; it retries next hour |
| `no summary for "…"` | `claude` missing, not logged in, or an unusable answer — the page is still written, with the feed's text and a note saying the summary is absent |
| `… not filed; they will be retried next sweep` | the vault commit failed (vault path, git remote). Nothing was marked seen |
| `a sweep is already running` (409) | one at a time, by design |

Failures are loud by construction: on stderr (cron sends it to
`/tmp/atlas-kit-addons.log`), in the sweep's `errors[]`, and in the run log that
`GET /api/addons` and `GET /api/news` report.

## 7. Turning it off

Remove `news-ingest` from `ATLAS_ADDONS` / `addons.json`, restart, and re-run
`sudo node scripts/addon-cron.mjs --install` to drop the cron line. The pages it wrote are
ordinary vault notes and stay. To also drop the skill link: `rm .claude/skills/news-ingest`.
