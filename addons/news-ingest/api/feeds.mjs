/* ------------------------------------------------------------------ *
 * The feed list: `feeds.json` — YOUR feeds, gitignored. `feeds.example.json` is
 * what ships, and it holds neutral public examples, never anybody's reading list.
 *
 * 🔴 A BAD ENTRY IS DROPPED, NOT FATAL. The file is hand-edited, so one line with
 * a typo is the expected failure — and losing every other feed to it would be the
 * wrong answer. Each rejection comes back in `errors[]` so the sweep can log it
 * and `GET /api/addons` can show it; only "no readable file at all" stops a run.
 *
 * Only http(s) URLs are accepted: this reads remote feeds, and a `file://` entry
 * in an operator-editable JSON file is a local-file read with a feed's shape.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import { feedsFile } from './config.mjs'

/** A stable, filename-safe tag for a feed with no explicit one: its host. */
export function tagFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '-').toLowerCase()
  } catch {
    return 'feed'
  }
}

/** Normalize one entry, or `null` + a reason. Accepts a bare URL string too —
 *  the shortest thing an operator will write is a list of URLs. */
export function normalizeFeed(raw, i) {
  const entry = typeof raw === 'string' ? { url: raw } : raw
  const where = `feeds[${i}]`
  if (!entry || typeof entry !== 'object') return { error: `${where}: not a URL or an object` }
  const url = String(entry.url || '').trim()
  if (!url) return { error: `${where}: missing "url"` }
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { error: `${where}: "${url}" is not a URL` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `${where}: only http(s) feeds are read, not ${parsed.protocol}` }
  }
  const tag = String(entry.tag || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return { feed: { url, tag: tag || tagFromUrl(url), title: String(entry.title || '').trim().slice(0, 120) } }
}

/**
 * `{ feeds, errors, file, exists }`. Never throws — an absent file is the
 * first-run state (install.sh writes one), not an exception.
 */
export function loadFeeds(file = feedsFile()) {
  let text
  try {
    text = fs.readFileSync(file, 'utf-8')
  } catch {
    return { file, exists: false, feeds: [], errors: [`no feed list at ${file} — copy feeds.example.json to feeds.json and put your own feeds in it`] }
  }
  let json
  try {
    json = JSON.parse(text)
  } catch (e) {
    return { file, exists: true, feeds: [], errors: [`${file} is not valid JSON: ${e.message}`] }
  }
  const list = Array.isArray(json) ? json : Array.isArray(json?.feeds) ? json.feeds : null
  if (!list) return { file, exists: true, feeds: [], errors: [`${file}: expected {"feeds": [...]} or a bare array`] }

  const feeds = []
  const errors = []
  const seen = new Set()
  list.forEach((raw, i) => {
    const { feed, error } = normalizeFeed(raw, i)
    if (error) return errors.push(error)
    if (seen.has(feed.url)) return errors.push(`feeds[${i}]: duplicate URL ${feed.url} — ignored`)
    seen.add(feed.url)
    feeds.push(feed)
  })
  if (!feeds.length && !errors.length) errors.push(`${file} lists no feeds`)
  return { file, exists: true, feeds, errors }
}
