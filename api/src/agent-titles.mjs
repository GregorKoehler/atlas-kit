/* ------------------------------------------------------------------ *
 * Spawn-time short titles for dev agents.
 *
 * A spawned agent is otherwise labeled by its raw task prompt, which is far
 * too long for the hero's agents overview. On every successful spawn the
 * proxy fires generateTitle() — a `claude -p` haiku sub-agent (subscription
 * auth, no tools; see .claude/rules/claude-p-subagent.md) that compresses
 * the prompt into TWO labels in one pass: a 3-6 word `title` and an
 * ultra-short ~1-2 word `micro` tag for narrow/mobile glance views. Fire-and-
 * forget OFF the spawn path: the spawn response never waits, and a failure
 * just means the UI falls back to the title, then the raw task text.
 *
 * Titles are decorated onto GET /api/agents sessions by id — that works for
 * BOTH executors (box-local and the workstation bridge) with no bridge
 * change. The map persists in ~/.atlas-kit/titles.json, capped;
 * ids of killed sessions simply stop matching and age out of the cap.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const STATE_DIR = process.env.AGENT_LOCAL_DIR || path.join(os.homedir(), '.atlas-kit')
const TITLES_FILE = path.join(STATE_DIR, 'titles.json')
const MODEL = process.env.AGENT_TITLE_MODEL || 'claude-haiku-4-5'
const TIMEOUT_MS = Number(process.env.AGENT_TITLE_TIMEOUT_MS || 60000)
const MAX_ENTRIES = 200
const MAX_LEN = 64
// Hard cap for the micro tag (prompt asks for ≤16; small tolerance so a decent
// 17-18 char tag isn't rejected — the deterministic fallback truncates to it).
const MAX_MICRO = 18

let titles = {}
try {
  const t = JSON.parse(fs.readFileSync(TITLES_FILE, 'utf-8'))
  if (t && typeof t === 'object' && !Array.isArray(t)) titles = t
} catch {
  /* first run — no titles yet */
}

function persist() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(TITLES_FILE, JSON.stringify(titles, null, 2))
  } catch (e) {
    console.error('[agent-titles] persist failed:', e.message)
  }
}

/** Decorate sessions (from any bridge) with their generated `title` + `micro`.
 * Legacy entries persisted as a bare string carry the title only. */
export function withTitles(sessions) {
  return sessions.map((s) => {
    const t = titles[s.id]
    if (!t) return s
    if (typeof t === 'string') return { ...s, title: t }
    return { ...s, title: t.title, micro: t.micro }
  })
}

const buildPrompt = (task) =>
  `Write two display labels and one size estimate for the dev-agent task below — they label the running agent on a dashboard.

Return EXACTLY three lines, nothing else:
TITLE: <3-6 words, at most 48 characters — the gist: what is being changed, and where>
MICRO: <1-2 words, at most 16 characters — an ultra-short tag for narrow/mobile views>
SIZE: <one letter — S, M, or L — your estimate of how much WORK this task is>

Sizing guide (it feeds a run-time estimate, so judge effort, not importance):
- S: a quick question, a one-line/one-file fix, or a small tweak.
- M: a typical change spanning a few files — the common case.
- L: a substantial feature, a broad refactor, or an open-ended investigation.

Rules: plain text, no quotes, no trailing period, no emoji, no other prefixes. Name the gist, not the phrasing.

=== TASK ===
${String(task).slice(0, 4000)}`

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--model', MODEL, '--output-format', 'text'], {
      cwd: os.homedir(), // neutral cwd — don't pull in any project's CLAUDE.md
      stdio: ['pipe', 'pipe', 'pipe'],
      // Empty key → claude -p uses subscription auth, never API-key billing.
      env: { ...process.env, ANTHROPIC_API_KEY: '' },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`claude -p timed out after ${TIMEOUT_MS}ms`))
    }, TIMEOUT_MS)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`failed to spawn claude: ${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        // claude -p prints some failures (e.g. billing) to stdout, not stderr.
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

// One label value: unquoted, no trailing period, whitespace collapsed.
function cleanVal(s) {
  return String(s || '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\.\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Pull the `TITLE:`, `MICRO:` and `SIZE:` lines out of the model's answer. Size
// is best-effort — only S/M/L count; anything else stays empty (no size).
function parseLabels(out) {
  let title = ''
  let micro = ''
  let size = ''
  for (const raw of String(out || '').split('\n')) {
    const line = raw.trim()
    const mt = line.match(/^TITLE:\s*(.+)$/i)
    const mm = line.match(/^MICRO:\s*(.+)$/i)
    const ms = line.match(/^SIZE:\s*([SML])\b/i)
    if (mt && !title) title = cleanVal(mt[1])
    else if (mm && !micro) micro = cleanVal(mm[1])
    else if (ms && !size) size = ms[1].toUpperCase()
  }
  return { title, micro, size }
}

// Deterministic micro fallback: as many leading title words as fit MAX_MICRO.
function microFromTitle(title) {
  const words = title.split(' ')
  let m = words[0] || ''
  for (let i = 1; i < words.length; i++) {
    const next = `${m} ${words[i]}`
    if (next.length > MAX_MICRO) break
    m = next
  }
  return m.slice(0, MAX_MICRO)
}

/**
 * Generate + persist the {title, micro} labels for a freshly spawned session and
 * RETURN {title, micro, size} (size is the task's S/M/L work estimate — the
 * caller stamps it onto the box-local session so it feeds the run-time estimator;
 * absent for a workstation agent or when the model omitted it). Never throws and
 * never blocks the spawn response. Validate-retry-once (the sub-agent rule): one
 * corrective re-prompt, then give up — the UI falls back to the title (then the
 * raw task). A bad/missing micro is derived from the title deterministically, so
 * the short label is never empty. Size never triggers the retry — it's optional.
 */
export async function generateTitle(id, task) {
  try {
    let { title, micro, size } = parseLabels(await runClaude(buildPrompt(task)))
    const bad = !title || title.length > MAX_LEN || !micro || micro.length > MAX_MICRO
    if (bad) {
      const retry =
        buildPrompt(task) +
        `\n\nYour previous answer was invalid. Return EXACTLY three lines: "TITLE: ..." (3-6 words, max 48 chars), "MICRO: ..." (1-2 words, max 16 chars) and "SIZE: ..." (S, M, or L).`
      const r = parseLabels(await runClaude(retry))
      title = r.title || title
      micro = r.micro || micro
      size = r.size || size
    }
    if (!title) return
    title = title.slice(0, MAX_LEN)
    if (!micro || micro.length > MAX_MICRO) micro = microFromTitle(title)
    titles[id] = { title, micro }
    // Cap: drop the oldest entries (insertion order) — stale ids age out here.
    const ids = Object.keys(titles)
    for (const k of ids.slice(0, Math.max(0, ids.length - MAX_ENTRIES))) delete titles[k]
    persist()
    return { title, micro, size: size || undefined }
  } catch (e) {
    console.error(`[agent-titles] title for "${id}" failed:`, e.message)
  }
}

/* ------------------------------------------------------------------ *
 * Batched micro tags for the sub-agents / background jobs a dev agent fans out.
 * These already arrive with an agent-authored description (their `label`), so —
 * unlike the dev-agent task above — there's no giant prompt to compress; we only
 * derive the same glance-form `micro` the overview shows. Discovery is poll-based,
 * so one poll can surface a whole fan-out: we compress them ALL in ONE haiku pass
 * instead of a process per job. Not persisted here (the caller stores each micro
 * on its session's job log) — this is a pure labels-in → Map<id, micro>-out helper.
 * ------------------------------------------------------------------ */
const MAX_MICRO_BATCH = 24

const cleanLabel = (s) => String(s || '').replace(/\s+/g, ' ').trim()

const buildMicrosPrompt = (items) =>
  `Write an ultra-short display tag for each task below. They label small jobs (sub-agents and background commands) a dev agent fanned out, shown in a cramped list on a dashboard — so each tag must be tiny.

Return one line per item, EXACTLY in this form and order:
<number>: <1-2 words, at most 16 characters>

Name the gist — what the job does — not its phrasing. Plain text only: no quotes, no trailing period, no emoji, no extra words.

=== ITEMS ===
${items.map((it, i) => `${i + 1}. ${cleanLabel(it.label).slice(0, 200)}`).join('\n')}`

// Pull `<n>: <micro>` lines out of the batch answer → Map<1-based index, micro>.
function parseMicros(out, n) {
  const got = new Map()
  for (const raw of String(out || '').split('\n')) {
    const m = raw.trim().match(/^(\d+)[).:]?\s+(.+)$/)
    if (!m) continue
    const idx = Number(m[1])
    if (idx < 1 || idx > n || got.has(idx)) continue
    // Strip any leftover list/bullet punctuation a malformed line might carry.
    const v = cleanVal(m[2].replace(/^[-–—•·:.\s]+/, ''))
    if (v) got.set(idx, v)
  }
  return got
}

/**
 * Compress a batch of `[{ id, label }]` jobs into Map<id, micro> in one `claude -p`
 * haiku pass. EVERY input id gets a micro: the model's tag when valid, else a
 * deterministic truncation of its label (microFromTitle) — so the caller can mark
 * each job tagged and never re-fire. Never throws, never blocks the poll. At most
 * MAX_MICRO_BATCH per call; the caller picks up any overflow on its next poll.
 */
export async function generateMicros(items) {
  const batch = (items || []).filter((it) => it && it.id && it.label).slice(0, MAX_MICRO_BATCH)
  const out = new Map()
  if (!batch.length) return out
  let got = new Map()
  try {
    got = parseMicros(await runClaude(buildMicrosPrompt(batch)), batch.length)
  } catch (e) {
    // Total failure → every id falls back to the deterministic micro below.
    console.error('[agent-titles] micro batch failed:', e.message)
  }
  batch.forEach((it, i) => {
    let m = got.get(i + 1)
    if (!m || m.length > MAX_MICRO) m = microFromTitle(cleanLabel(it.label))
    out.set(it.id, m.slice(0, MAX_MICRO))
  })
  return out
}
