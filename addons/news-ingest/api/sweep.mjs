/* ------------------------------------------------------------------ *
 * The sweep: every configured feed → the items you have not seen → one commit.
 *
 *   load feeds → fetch each (bounded, timed out) → parse → drop what is already
 *   in seen-state → cap (per feed, then per run) → summarize each with claude -p
 *   → render pages + the digest → COMMIT QUEUE → mark seen → run record
 *
 * 🔴 ONE FEED FAILING MUST NOT KILL THE RUN. A feed is someone else's server:
 * it 500s, it hangs, it serves an HTML error page with an XML content-type. Each
 * one is caught per feed, recorded with its reason and logged LOUDLY, and the
 * other feeds still land. The only fatal conditions are "no feed list" and "no
 * vault" — with either, there is nothing a run could do.
 *
 * 🔴 SEEN IS MARKED AFTER THE COMMIT, NEVER BEFORE. See api/state.mjs: marking
 * first would silently drop items whose commit failed; marking after can at
 * worst re-summarize them next run, which costs one `claude -p` and loses
 * nothing.
 *
 * 🔴 ONE COMMIT PER RUN, NOT ONE PER ITEM. The vault's serial queue is shared
 * with every other writer, and twelve pull-rebase-push cycles for twelve
 * headlines would hold it for minutes. So the whole run is one job.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import { enqueueAtlasCommit } from '../../../api/src/atlas-commit-queue.mjs'
import { resolveVault } from '../../../api/src/vaults.mjs'
import { loadFeeds } from './feeds.mjs'
import { parseFeed, itemKey } from './parse.mjs'
import { renderItemPage, renderDigest, pagePathFor } from './page.mjs'
import { summarize as summarizeItem } from './summarize.mjs'
import { readState, saveState, recentItems } from './state.mjs'
import { limits, timeouts, digestPage, vaultKey } from './config.mjs'

let running = false

/** Read at most `max` bytes of a response. A feed body is text — anything larger
 *  than the cap is a mistake at the other end, and reading it all would be ours. */
async function readBounded(res, max) {
  if (!res.body?.getReader) return String(await res.text()).slice(0, max)
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(Buffer.from(value))
    total += value.length
    if (total >= max) {
      await reader.cancel()
      break
    }
  }
  return Buffer.concat(chunks).toString('utf-8').slice(0, max)
}

/** Fetch one feed body. Throws with an actionable message — the caller turns
 *  that into a per-feed error and carries on. */
export async function fetchFeed(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    headers: { accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8', 'user-agent': 'atlas-kit-news-ingest' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeouts().fetch),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`)
  const body = await readBounded(res, limits().feedBytes)
  if (!body.trim()) throw new Error('the response was empty')
  return body
}

/** Round-robin across feeds so one busy feed cannot eat the whole run cap: each
 *  feed contributes its newest unseen item, then its second, until the cap. */
export function selectNew({ perFeed, total, buckets }) {
  const queues = buckets.map((b) => b.items.slice(0, perFeed))
  const out = []
  for (let round = 0; out.length < total && queues.some((q) => q.length > round); round++) {
    for (let i = 0; i < queues.length && out.length < total; i++) {
      const item = queues[i][round]
      if (item) out.push({ feed: buckets[i].feed, item })
    }
  }
  return out
}

/**
 * Run one sweep.
 *
 * `fetchImpl` and `summarizeImpl` are injectable so the pipeline can be tested
 * without a network and without a model — everything else is the real thing,
 * including the vault and its commit queue.
 */
export async function sweepNews({ requestedBy = 'cron', fetchImpl = fetch, summarizeImpl = summarizeItem, now = () => new Date() } = {}) {
  if (running) return { ok: false, status: 409, error: 'a sweep is already running — one at a time' }
  running = true
  const at = now().toISOString()
  const errors = []
  const fail = (status, error) => {
    console.error(`[news-ingest] sweep FAILED: ${error}`)
    return { ok: false, status, at, error, errors }
  }

  try {
    const { feeds, errors: feedErrors, file } = loadFeeds()
    errors.push(...feedErrors)
    for (const e of feedErrors) console.error(`[news-ingest] ${e}`)
    if (!feeds.length) return fail(500, `no usable feeds in ${file}`)

    const vault = resolveVault(vaultKey())
    if (!vault?.path || !fs.existsSync(vault.path)) {
      return fail(500, `vault not available (${vault?.path || 'no VAULT_PATH'}) — the pages have nowhere to land`)
    }

    const state = readState()
    const cap = limits()

    // 1. Fetch + parse every feed. A failure here is one feed's, never the run's.
    const buckets = []
    let checked = 0
    for (const feed of feeds) {
      try {
        const parsed = parseFeed(await fetchFeed(feed.url, fetchImpl), { excerptChars: cap.excerptChars })
        checked += parsed.items.length
        const fresh = parsed.items.filter((item) => !state.seen[itemKey(feed.url, item.id)])
        buckets.push({ feed: { ...feed, title: feed.title || parsed.title }, items: fresh })
      } catch (e) {
        const msg = `${feed.tag}: ${String(e?.message || e)}`
        errors.push(msg)
        console.error(`[news-ingest] feed FAILED — ${msg} (${feed.url})`)
      }
    }

    const picked = selectNew({ perFeed: cap.perFeed, total: cap.items, buckets })
    const available = buckets.reduce((n, b) => n + b.items.length, 0)
    const deferred = available - picked.length
    if (deferred > 0) {
      // Not a silent truncation: the cap is the cost control, and what it held
      // back arrives on the next runs.
      console.error(`[news-ingest] ${deferred} new item(s) over the per-run cap (${cap.items}) — deferred to the next sweep`)
    }
    if (!picked.length) {
      const run = { at, requestedBy, feeds: feeds.length, checked, new: 0, written: 0, deferred: 0, errors, ok: true }
      state.runs.push(run)
      saveState(state)
      console.error(`[news-ingest] ${checked} item(s) across ${feeds.length} feed(s), none new${errors.length ? `, ${errors.length} error(s)` : ''}`)
      return { ...run, status: 200, items: [] }
    }

    // 2. Summarize each item. Best-effort, per item: a model failure is stated
    //    on that page and costs nothing else.
    const written = []
    for (const { feed, item } of picked) {
      const summary = await summarizeImpl({ item, feed })
      if (!summary.ok) {
        const msg = `no summary for "${item.title}": ${summary.error}`
        errors.push(msg)
        console.error(`[news-ingest] ${msg}`)
      }
      const key = itemKey(feed.url, item.id)
      const page = pagePathFor({ title: item.title, key })
      written.push({
        key,
        page,
        markdown: renderItemPage({ item, feed, summary, ingestedAt: at, excerptTruncated: item.summaryTruncated }),
        entry: { at, title: item.title, url: item.link, feed: feed.tag, page },
      })
    }

    // 3. The digest — the new items on top of what is already ingested. Built
    //    BEFORE the commit so the whole run is one write of one consistent view.
    const merged = { seen: { ...state.seen, ...Object.fromEntries(written.map((w) => [w.key, w.entry])) } }
    const digestRel = digestPage()
    // EVERY configured feed is listed, not just the ones that answered — a feed
    // that is failing must not quietly vanish from the page that claims to say
    // what is being followed. Titles resolved this run win over the config's.
    const titles = new Map(buckets.map((b) => [b.feed.tag, b.feed.title]))
    const digestMd = renderDigest({
      items: recentItems(merged, cap.digestItems),
      feeds: feeds.map((f) => ({ ...f, title: titles.get(f.tag) || f.title })),
      generatedAt: at,
    })

    // 4. One commit, through the vault's single writer.
    const commit = await enqueueAtlasCommit({
      message: `news: ${written.length} item(s) from ${buckets.length} feed(s)`,
      paths: [...written.map((w) => w.page), digestRel],
      vault: vaultKey(),
      mutate: async (atlas) => {
        for (const { page, markdown } of [...written, { page: digestRel, markdown: digestMd }]) {
          const abs = path.join(atlas, page)
          fs.mkdirSync(path.dirname(abs), { recursive: true })
          fs.writeFileSync(abs, markdown, 'utf-8')
        }
      },
    })

    const run = {
      at,
      requestedBy,
      feeds: feeds.length,
      checked,
      new: picked.length,
      written: commit.ok ? written.length : 0,
      deferred: Math.max(0, deferred),
      errors,
      ok: !!commit.ok,
      ...(commit.ok ? {} : { error: commit.warning || 'the vault commit failed' }),
    }
    state.runs.push(run)
    if (commit.ok) for (const w of written) state.seen[w.key] = w.entry
    saveState(state)

    if (!commit.ok) {
      // Nothing is marked seen, so the next sweep retries these items.
      return fail(500, `${run.error} — ${written.length} item(s) not filed; they will be retried next sweep`)
    }
    console.error(
      `[news-ingest] ${written.length} item(s) from ${buckets.length} feed(s) → ${digestRel}${errors.length ? `, ${errors.length} error(s)` : ''}`,
    )
    return { ...run, status: 200, digest: digestRel, items: written.map((w) => w.entry) }
  } catch (e) {
    return fail(500, `unexpected sweep failure: ${String(e?.message || e)}`)
  } finally {
    running = false
  }
}
