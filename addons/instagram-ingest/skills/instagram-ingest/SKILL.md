---
name: instagram-ingest
description: File one Instagram post or reel into the Atlas vault as a Wiki/Sources page. Use when asked to "ingest this reel", "save this Instagram post", "add this IG link to the vault", or when handed an instagram.com/p|reel|tv/ URL to keep. Needs the optional addons/instagram-ingest addon enabled and the operator's own cookies configured.
---

# Ingest an Instagram post into the vault

One post per run. This skill does not crawl profiles, hashtags or "everything I saved" —
the endpoint refuses those URLs, and so should you.

## 1. Check the URL

It must be a single permalink: `https://www.instagram.com/p/<code>/`, `/reel/<code>/` or
`/tv/<code>/` (a `<username>/p/<code>/` form is fine; tracking params are dropped for you).
A profile, a hashtag, an `/explore/` or a `/stories/` URL is **not ingestible** — say so and
stop rather than trying a variant.

## 2. Check the addon is live

```bash
curl -s http://127.0.0.1:${API_PORT:-3001}/api/addons | grep -q instagram-ingest
```

Not listed → the addon is not enabled on this box. Tell the operator to add
`instagram-ingest` to `ATLAS_ADDONS` (or `addons.json`) and restart the API; do not try to
enable it yourself. `GET /api/addons` also carries this addon's `status` — whether `yt-dlp`
resolved and whether cookies are configured. Both matter for step 4's triage.

## 3. Run it

```bash
curl -s -X POST http://127.0.0.1:${API_PORT:-3001}/api/ingest/instagram \
  -H "Authorization: Bearer $DASHBOARD_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.instagram.com/p/<code>/"}'
```

It answers when the page is committed — an ingest is two external calls and a model pass, so
allow a couple of minutes. Without a running API (or without the bearer), the same pipeline
runs from the shell:

```bash
node --env-file=.env addons/instagram-ingest/scripts/ingest.mjs '<url>'
```

## 4. Read the answer honestly

Success is `{ ok: true, page, images, analysis, warnings }`.

- `warnings` is **not** decoration. Report every entry — "no analysis", "no images fetched",
  "no written caption", a truncated caption or a dropped carousel slide all mean the page is
  thinner than the post. They are on the page too, in a warning callout.
- `analysis: false` means the model never produced a usable answer; the caption and media are
  still there. That is a partial success — say which half is missing.

Failures, and what each one actually means:

| status | meaning | what to say |
|---|---|---|
| 400 | not a single-post URL | the URL cannot be ingested; do not retry a variant |
| 409 | another ingest is running | wait and retry once — there is one at a time, by design |
| 401/500 `bearer` | no/bad `DASHBOARD_BEARER_TOKEN` | an operator config problem, not a post problem |
| 500 `cookies file … does not exist` | `ATLAS_IG_COOKIES_FILE` points at nothing | cookies must be re-exported (README) |
| 502 login/private/429/403 | Instagram refused | see the triage below |
| 500 `vault commit failed` | the vault write failed | the page did not land; the vault is left clean |

**502 triage — the message already carries the hint, do not guess past it:**

- *no cookies configured* → Instagram serves a login wall to logged-out clients. The operator
  must configure their own cookies; you cannot fix this from here.
- *cookies configured* → most likely **expired**: a cookie jar is a live login session and is
  invalidated by logging out, changing the password, or simply by time. Re-export it.
  The same error also covers a **private** account the operator does not follow, a **deleted**
  post, and a **geo-blocked** one — Instagram does not distinguish them from out here, so
  neither should you. Never claim which one it was.
- Repeated 502s in a short window can be **rate-limiting**. Stop; do not retry in a loop.

## 5. Verify the page

Read the committed page (`page` from the response) before you report done:

```bash
curl -s "http://127.0.0.1:${API_PORT:-3001}/api/note?path=Wiki/Sources/instagram-<code>.md"
```

Confirm the source URL is on it and the caption section holds the post's own words. Then
report: the page path, the title, how many images landed, and every warning. If the operator
wanted the post filed under a project or linked from somewhere, that is a separate edit —
this skill writes exactly one Source page.
