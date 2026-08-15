---
name: news-ingest
description: Sweep the operator's configured RSS/Atom feeds into the Atlas vault now, report what came in, and adjust the feed list. Use when asked to "check the feeds", "pull the news", "run a news sweep", "what came in from my feeds", or to add/remove a feed. Needs the optional addons/news-ingest addon enabled.
---

# Sweep the news feeds into the vault

One sweep per run. This is a poller, not a crawler: it reads the feeds in
`addons/news-ingest/feeds.json`, files the items that are new, and stops. It never
follows links out of a feed and never fetches an article page.

## 1. Check the addon is live

```bash
curl -s http://127.0.0.1:${API_PORT:-3001}/api/addons | grep -q news-ingest
```

Not listed → the addon is not enabled on this box. Tell the operator to add `news-ingest` to
`ATLAS_ADDONS` (or `addons.json`) and restart the API; do not try to enable it yourself.
`GET /api/addons` also carries this addon's `status` — how many feeds parsed, any feed-list
errors, the caps, and how the last sweep went. Read it before running anything: "0 feeds"
means the operator has not written a `feeds.json` yet, and a sweep would only tell you that
again.

## 2. Run the sweep

```bash
curl -s -X POST http://127.0.0.1:${API_PORT:-3001}/api/news/sweep \
  -H "Authorization: Bearer $DASHBOARD_BEARER_TOKEN"
```

It answers when the pages are committed. **This spends the operator's Claude subscription:**
one `claude -p` call per new item, up to `ATLAS_NEWS_MAX_ITEMS` (12 by default). Run it once
when asked; never in a loop, and never "to see if anything changed" — cron already does that
hourly.

Without a running API (or without the bearer), the same run works from the shell:

```bash
node --env-file=.env addons/news-ingest/scripts/sweep.mjs
```

## 3. Read the answer honestly

```json
{ "ok": true, "feeds": 3, "checked": 90, "new": 12, "written": 12, "deferred": 4, "errors": [], "items": [...] }
```

- `errors` is **not** decoration. Report every entry. A feed that 500s, a feed list line with a
  typo, an item whose summary failed — each one means the sweep is thinner than it looks, and
  a run can be `ok: true` with several of them.
- `deferred` > 0 means the per-run cap held items back. They are **not lost**; the next sweep
  takes them. Say so rather than implying the feed was fully ingested.
- `new: 0` is the normal, healthy answer between publishing cycles. It is not a failure and
  does not need a retry.
- `ok: false` with `not filed; they will be retried next sweep` means the vault commit failed:
  nothing was marked as seen, so nothing is lost. That is an operator problem (vault, git
  remote), not a feed problem.

## 4. Review what came in

```bash
curl -s "http://127.0.0.1:${API_PORT:-3001}/api/news?limit=20"
```

Each item has its own `Wiki/Sources/news-<slug>.md` page, and the rolling digest lives at
`Wiki/News-Digest.md` (live state — it is **rewritten** on every sweep, so never edit it and
never treat it as a record). Read a page before summarizing it back:

```bash
curl -s "http://127.0.0.1:${API_PORT:-3001}/api/note?path=Wiki/Sources/news-<slug>.md"
```

Each page carries the feed's own excerpt verbatim under **From the feed**, and the model's
summary above it. The summary was written from the excerpt alone — the article itself was
never opened — so do not present it as a read of the source, and if the operator needs the
real content, say that it has to be opened.

## 5. Adjusting the feed list

`addons/news-ingest/feeds.json` (gitignored, seeded from `feeds.example.json`):

```json
{ "feeds": [ { "url": "https://example.org/feed.xml", "tag": "example", "title": "Example" } ] }
```

`tag` defaults to the host and `title` to the feed's own `<title>`; a bare URL string is a
valid entry. Adding a feed is safe — the first sweep after it takes at most
`ATLAS_NEWS_MAX_PER_FEED` items from it and the rest follow over the next runs. **Removing a
feed does not remove its pages**; they are ordinary vault notes and stay. Changes take effect
on the next sweep — no restart needed for `feeds.json` (only enabling/disabling the addon
itself is a restart).

Verify an edit before reporting it done:

```bash
bash addons/news-ingest/install.sh --check   # 0 configured · 2 not yet · 1 cannot
```
