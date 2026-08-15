/* ------------------------------------------------------------------ *
 * The vault page: one `Wiki/Sources/instagram-<code>.md` per post.
 *
 * Pure string work — no filesystem, no vault, no git — so the shape of what gets
 * committed is testable without any of them.
 *
 * Three things the layout guarantees, in descending order of how annoying it is
 * to lose them:
 *   1. THE SOURCE URL IS ON THE PAGE, twice: in the frontmatter (queryable) and
 *      in the Source section (readable). A note whose origin you cannot re-open
 *      is a rumour.
 *   2. THE CAPTION IS VERBATIM, in its own blockquoted section — never folded
 *      into the model's prose, where a paraphrase would quietly replace what the
 *      author actually wrote.
 *   3. WHAT FAILED IS ON THE PAGE. No analysis, no images, a truncated caption —
 *      each says so where the reader is, not only in a log they will never open.
 *
 * The slug is derived from the post code, so re-ingesting the same post updates
 * one page instead of accumulating near-duplicates.
 * ------------------------------------------------------------------ */
import path from 'node:path'

export const slugFor = (code) => `instagram-${code}`
export const pagePathFor = (code) => `Wiki/Sources/${slugFor(code)}.md`
export const assetsPathFor = (code) => `Wiki/assets/instagram/${code}`

/** The page-relative link to a staged asset (`Wiki/Sources/…` → `../assets/…`). */
export const assetLink = (code, name) => `../assets/instagram/${code}/${name}`

/** yt-dlp's `20260801` → `2026-08-01`; anything else → `''`. */
export function isoFromUploadDate(d) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(d || '').trim())
  return m ? `${m[1]}-${m[2]}-${m[3]}` : ''
}

const blockquote = (text) =>
  String(text)
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n')

/** Fallback title when the model never produced one: the caption's first line,
 *  else the bare post reference. Never empty — a page with no `# ` heading reads
 *  as broken in every renderer. */
export function fallbackTitle({ caption, kind, code }) {
  const first = String(caption || '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  if (first) return first.replace(/\s+/g, ' ').slice(0, 80)
  return `Instagram ${kind || 'post'} ${code}`
}

/**
 * Render the whole page.
 *
 * `analysis` is `{ ok, title, tags, body }` or `{ ok: false, error }`;
 * `images` is the list of staged asset FILE NAMES (already inside the vault);
 * `warnings` are the non-fatal things that went wrong on the way here.
 */
export function renderPage({ url, code, kind, caption = '', captionTruncated = false, analysis = { ok: false }, images = [], uploader = '', postedAt = '', ingestedAt, warnings = [] }) {
  const title = (analysis.ok && analysis.title) || fallbackTitle({ caption, kind, code })
  const tags = ['instagram', ...(analysis.ok ? analysis.tags || [] : [])].filter((t, i, a) => a.indexOf(t) === i)
  const created = String(ingestedAt || '').slice(0, 10)

  const fm = ['---', 'type: source', 'source: instagram', `url: "${url}"`, `created: ${created}`, `tags: [${tags.join(', ')}]`, '---'].join('\n')

  const out = [fm, '', `# ${title}`, '']

  if (analysis.ok) {
    out.push(analysis.body, '')
  } else {
    out.push(`*No analysis was written for this post — ${analysis.error || 'the analysis step did not run'}. The caption and media below are exactly what the post carried.*`, '')
  }

  out.push('## Original caption', '')
  if (caption) {
    out.push(blockquote(caption), '')
    if (captionTruncated) out.push('*(caption truncated by the ingest limit — open the post for the rest)*', '')
  } else {
    out.push('*The post carried no written caption.*', '')
  }

  if (images.length) {
    out.push('## Media', '')
    images.forEach((name, i) => out.push(`![${title} (${i + 1}/${images.length})](${assetLink(code, name)})`, ''))
  }

  out.push('## Source', '')
  out.push(`- ${url}`)
  if (uploader) out.push(`- Posted by @${uploader}${postedAt ? ` on ${postedAt}` : ''}`)
  else if (postedAt) out.push(`- Posted ${postedAt}`)
  out.push(`- Ingested ${created} by \`addons/instagram-ingest\``)
  out.push('')

  if (warnings.length) {
    out.push('> [!warning] Incomplete ingest', ...warnings.map((w) => `> - ${w}`), '')
  }
  return out.join('\n')
}

/** `1.jpg`, `2.png`, … — the vault never sees yt-dlp's own filenames. */
export const assetName = (i, file) => `${i + 1}${path.extname(file).toLowerCase() || '.jpg'}`
