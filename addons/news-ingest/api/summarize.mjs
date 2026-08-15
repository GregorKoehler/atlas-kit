/* ------------------------------------------------------------------ *
 * The `claude -p` half: one feed item → tags and a few sentences.
 *
 * The kit's standing claude-CLI pattern (see api/src/agent-titles.mjs): the
 * subscription CLI, `ANTHROPIC_API_KEY` blanked so it can never fall through to
 * API-key billing, prompt on stdin, a hard timeout, both streams merged into the
 * error detail because claude prints some failures to stdout.
 *
 * NO TOOLS, AND NOTHING BEYOND THE FEED. The model gets the headline and the
 * feed's own excerpt and nothing else — it does not open the article. That is a
 * deliberate bound, and it is why the page says "from the feed" rather than
 * pretending to a read of the source: a summary of an excerpt is what a feed can
 * honestly buy you, and fetching every linked page would be a crawler.
 *
 * A FEED IS UNTRUSTED TEXT. Whatever a publisher puts in a <description> reaches
 * this prompt, instructions included. The bound is that this call has NO TOOLS
 * and no network and its whole output is one section of one page — a hostile
 * excerpt can produce a silly summary, and cannot do anything else. The feed's
 * own words go on the page verbatim regardless, so the reader can see both.
 *
 * 🔴 THE SUMMARY IS BEST-EFFORT; THE ITEM IS NOT. Everything here returns
 * `{ ok: false, error }` rather than throwing, because a page carrying the
 * headline, the feed's own words and the URL is a good outcome even when the
 * model never ran — and one unusable answer must never cost the whole sweep.
 * ------------------------------------------------------------------ */
import { spawn } from 'node:child_process'
import { model, effort, timeouts } from './config.mjs'
import { requireClaudeBin } from '../../../api/src/claude-bin.mjs'

const MIN_BODY_CHARS = 40

/** The one-shot prompt. It states what the model does NOT have (the article
 *  itself), because the failure mode worth preventing here is a confident
 *  summary of a page nobody read. */
export function buildPrompt({ item, feed }) {
  return [
    'You are filing one news/blog item into a personal knowledge vault. Write the note for a reader who has NOT opened the article.',
    '',
    'Return EXACTLY this shape and nothing else:',
    'TAGS: <2-6 comma-separated lowercase tags, letters/digits/dashes only>',
    '',
    '<then a blank line, then 1-2 short markdown paragraphs (or a few bullets): what this item says and what is worth keeping from it — names, numbers, claims, what changed.>',
    '',
    'Rules: you have ONLY the headline and the feed excerpt below — you did NOT read the linked article. Summarize what is actually there, never invent detail the excerpt does not carry, and say plainly when the excerpt is too thin to say much. No preamble, no closing offer, no markdown fence around the whole answer, and do not repeat the headline as a heading.',
    '',
    `FEED: ${feed.title || feed.tag} (${feed.url})`,
    `HEADLINE: ${item.title || '(untitled)'}`,
    ...(item.link ? [`URL: ${item.link}`] : []),
    ...(item.published ? [`PUBLISHED: ${item.published}`] : []),
    '',
    item.summary
      ? ['EXCERPT — the feed\'s own text for this item:', '"""', item.summary, '"""'].join('\n')
      : 'EXCERPT: the feed carried no text for this item beyond the headline.',
  ].join('\n')
}

/** Strip a whole-answer markdown fence, which the CLI adds often enough to matter. */
export function sanitize(out) {
  const t = String(out || '').trim()
  const m = /^```(?:markdown|md)?\n([\s\S]*?)\n?```$/.exec(t)
  return (m ? m[1] : t).trim()
}

/** Tags become YAML frontmatter, so they are reduced to bare scalars here:
 *  lowercase, `[a-z0-9-]`, deduped, capped. A tag that survives nothing is
 *  dropped, not quoted. */
export function cleanTags(raw) {
  const out = []
  for (const t of String(raw || '').split(/[,;]/)) {
    const v = t
      .trim()
      .toLowerCase()
      .replace(/^#/, '')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
    if (v && v.length > 1 && !out.includes(v)) out.push(v)
    if (out.length === 6) break
  }
  return out
}

/** `{ tags, body }` out of the model's answer. Missing fields come back empty
 *  and are caught by validate() — this never throws on shape. */
export function parseSummary(out) {
  const text = sanitize(out)
  let tags = []
  const body = []
  for (const raw of text.split('\n')) {
    const m = /^TAGS:\s*(.+)$/i.exec(raw.trim())
    if (m && !tags.length) {
      tags = cleanTags(m[1])
      continue
    }
    body.push(raw)
  }
  return { tags, body: body.join('\n').trim() }
}

/** Why this answer is unusable, or `''`. Deliberately weak — it guards against
 *  an empty/refusal answer, not against prose we happen to dislike. Missing
 *  TAGS is NOT a rejection: the body is the part the reader came for. */
export function validate({ body }) {
  if (String(body).replace(/\s/g, '').length < MIN_BODY_CHARS) return 'the body was empty or near-empty'
  return ''
}

function runClaude(prompt) {
  const args = ['-p', '--model', model()]
  const e = effort()
  if (e) args.push('--effort', e)
  args.push('--output-format', 'text')
  const ms = timeouts().summary
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(requireClaudeBin(), args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ANTHROPIC_API_KEY: '' }, // subscription auth, never API-key billing
      })
    } catch (err) {
      return reject(new Error(`failed to spawn claude: ${err.message}`))
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`claude -p timed out after ${ms}ms`))
    }, ms)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`failed to spawn claude: ${err.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        const detail = [stderr, stdout]
          .map((x) => x.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' | ')
          .slice(0, 300)
        return reject(new Error(`claude -p exited ${code}: ${detail}`))
      }
      resolve(stdout)
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}

/**
 * Summarize one item. `{ ok: true, tags, body }` or `{ ok: false, error }`.
 *
 * ONE attempt, no retry: unlike a single manual ingest, a sweep has many items
 * and a per-item retry doubles the worst-case spend of the whole run for the
 * least valuable half of the page. A miss is stated on the page and the item is
 * still filed.
 */
export async function summarize({ item, feed }) {
  try {
    const parsed = parseSummary(await runClaude(buildPrompt({ item, feed })))
    const why = validate(parsed)
    if (why) return { ok: false, error: `claude -p returned an unusable answer (${why})` }
    return { ok: true, ...parsed }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}
