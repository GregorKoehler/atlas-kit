/* ------------------------------------------------------------------ *
 * The `claude -p` half: caption + stills → a title, tags and a few paragraphs.
 *
 * The kit's standing claude-CLI pattern (see api/src/agent-titles.mjs): the
 * subscription CLI, `ANTHROPIC_API_KEY` blanked so it can never fall through to
 * API-key billing, prompt on stdin, a hard timeout, both streams merged into the
 * error detail because claude prints some failures to stdout.
 *
 * IMAGES ARE PASSED AS PATHS, NOT BYTES. They are already staged at their final
 * home inside the vault, `cwd` is the vault, and the prompt asks the model to
 * open them with the Read tool (`--allowed-tools Read` — the only tool it gets).
 * Base64-inlining them would mean holding several MB of image in the prompt for
 * no gain.
 *
 * 🔴 ANALYSIS IS BEST-EFFORT; THE CAPTION IS NOT. Everything here returns
 * `{ ok: false, error }` rather than throwing, because a page carrying the post's
 * own words and its URL is a good outcome even when the model never ran — and
 * losing the caption to a model failure is the one outcome that is not.
 * ------------------------------------------------------------------ */
import { spawn } from 'node:child_process'
import { model, effort, timeouts } from './config.mjs'
import { requireClaudeBin } from '../../../api/src/claude-bin.mjs'

const MAX_TITLE = 120
const MIN_BODY_CHARS = 40

/**
 * The one-shot prompt. It STEERS ON WHAT IS ACTUALLY PRESENT: with a caption, the
 * model is told the caption carries what the imagery skips (names, quantities,
 * credits, links) and to keep its words; with no stills, it is told so plainly
 * rather than left to invent them.
 */
export function buildPrompt({ url, caption, imageRels = [] }) {
  const lines = [
    'You are filing one Instagram post into a personal knowledge vault. Write the note for a reader who has NOT seen the post.',
    '',
    'Return EXACTLY this shape and nothing else:',
    'TITLE: <a specific 3-10 word title — what this post IS, not "Instagram post">',
    'TAGS: <2-6 comma-separated lowercase tags, letters/digits/dashes only>',
    '',
    '<then a blank line, then 1-3 short markdown paragraphs: what the post shows and says, and anything in it worth keeping — names, places, steps, quantities, links, claims. Bullet points are fine.>',
    '',
    'Rules: describe only what is actually in the caption or the images. Do not guess at what is off-frame, do not invent numbers, and say so plainly when something is unclear. No preamble, no closing offer, no markdown fence around the whole answer.',
    '',
    `POST URL: ${url}`,
  ]
  if (imageRels.length) {
    lines.push(
      '',
      `IMAGES — open EACH of these with the Read tool. They are all from the SAME post${imageRels.length > 1 ? ' (a carousel or a reel, in order)' : ''}:`,
      ...imageRels.map((p) => `- ${p}`),
    )
  } else {
    lines.push('', 'IMAGES: none could be fetched — work from the caption alone and do not describe imagery you cannot see.')
  }
  if (caption) {
    lines.push(
      '',
      "CAPTION — the post's own written text. It routinely carries what the imagery does not (names, quantities, credits, links); keep its specifics and prefer its own wording for them:",
      '"""',
      caption,
      '"""',
    )
  } else {
    lines.push('', 'CAPTION: the post carried no written caption.')
  }
  return lines.join('\n')
}

/** Strip a whole-answer markdown fence, which the CLI adds often enough to matter. */
export function sanitize(out) {
  const t = String(out || '').trim()
  const m = /^```(?:markdown|md)?\n([\s\S]*?)\n?```$/.exec(t)
  return (m ? m[1] : t).trim()
}

/** Tags become YAML frontmatter, so they are reduced to bare scalars here: lowercase,
 *  `[a-z0-9-]`, deduped, capped. A tag that survives nothing is dropped, not quoted. */
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

/** `{ title, tags, body }` out of the model's answer. Missing fields come back
 *  empty and are caught by validate() — this never throws on shape. */
export function parseAnalysis(out) {
  const text = sanitize(out)
  let title = ''
  let tags = []
  const body = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const mt = /^TITLE:\s*(.+)$/i.exec(line)
    const mg = /^TAGS:\s*(.+)$/i.exec(line)
    if (mt && !title) {
      title = mt[1].replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
      continue
    }
    if (mg && !tags.length) {
      tags = cleanTags(mg[1])
      continue
    }
    body.push(raw)
  }
  return { title, tags, body: body.join('\n').trim() }
}

/** Why this answer is unusable, or `''`. Deliberately weak — it guards against an
 *  empty/refusal answer, not against prose we happen to dislike. */
export function validate({ title, body }) {
  if (!title) return 'no TITLE: line'
  if (body.replace(/\s/g, '').length < MIN_BODY_CHARS) return 'the body was empty or near-empty'
  return ''
}

function runClaude(prompt, cwd) {
  const args = ['-p', '--model', model()]
  const e = effort()
  if (e) args.push('--effort', e)
  args.push('--allowed-tools', 'Read', '--output-format', 'text')
  const ms = timeouts().analysis
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(requireClaudeBin(), args, {
        cwd, // the vault, so the staged image paths in the prompt resolve
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
 * Analyze one post. `{ ok: true, title, tags, body }` or `{ ok: false, error }`.
 *
 * Validate → ONE corrective re-prompt → give up. One retry, never a loop: a model
 * that ignored the shape twice will ignore it a third time, and the page is
 * written either way.
 */
export async function analyze({ url, caption, imageRels = [], cwd }) {
  if (!caption && !imageRels.length) return { ok: false, error: 'nothing to analyze — no caption and no images' }
  const prompt = buildPrompt({ url, caption, imageRels })
  try {
    let parsed = parseAnalysis(await runClaude(prompt, cwd))
    let why = validate(parsed)
    if (why) {
      const retry = `${prompt}\n\nYour previous answer was invalid (${why}). Return the exact shape: a "TITLE: …" line, a "TAGS: …" line, a blank line, then the paragraphs.`
      const second = parseAnalysis(await runClaude(retry, cwd))
      why = validate(second)
      if (why) return { ok: false, error: `claude -p returned an unusable answer twice (${why})` }
      parsed = second
    }
    return { ok: true, ...parsed }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}
