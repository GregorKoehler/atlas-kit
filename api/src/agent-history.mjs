// Full chat-history reconstruction from Claude Code's on-disk `.jsonl` transcripts.
//
// The dashboard's live transcript is a tmux capture — only the visible pane. The
// COMPLETE conversation lives in Claude Code's per-session `.jsonl` files under
// `~/.claude/projects/<projectKey(cwd)>/`. This module reads, filters, stitches and
// parses those into a flat message list the client renders as chat.
//
// Fragmentation (verified on the box): `claude --resume` FORKS a new session file
// each revive (it doesn't re-pin the id or append), and forks do NOT link via
// `parentUuid`. So the stitch strategy depends on whether the project dir is 1:1
// with the agent:
//   • Unique-worktree agents (dev, atlas workers): the dir holds only this agent's
//     sessions → enumerate ALL `.jsonl` and stitch → full history INCLUDING revives.
//   • Shared-cwd chats (knowledge / atlas orchestrator, kind:'knowledge'): the vault
//     dir is shared by many unrelated chats → restrict to the pinned
//     `<sessionId>.jsonl` (the full ORIGINAL conversation; post-revive forks there
//     can't be attributed, a documented limitation).
// Aborted spawns leave tiny stub files with no assistant message — dropped.
//
// The OPENING turn is special-cased: it is not a chat message but the whole
// prompt the agent was launched with (preamble + retrieved Atlas evidence + the
// operator's question), and the 20 KB per-message cap was cutting nearly half
// off it mid-evidence — silently, so a complete retrieval read as an empty one.
// It keeps its text up to MAX_FIRST_TEXT; see capText / stitchParsed.
//
// A message delivered MID-TURN (boundary delivery) is special-cased too: the
// harness records it as a `queued_command` attachment rather than a user turn,
// so the chat view had NO record of it at all. See parseTranscript / placeQueued
// — recognition there, re-ordering here.
//
// An OUTBOUND agent-control call (an Atlas orchestrator instructing a dev agent)
// is special-cased for the same reason: its brief is kilobytes of structured
// text in `input.text`/`input.task`, and NEITHER key is in toolSummary's pick
// list — so the chip fell through to the first string value in the input, i.e.
// the recipient's session id (or, for spawn_agent, the repo name), and the
// instruction itself was DESTROYED here, in the API, before the browser ever saw
// it. A structured `outbound` field carries the byte-exact argument through
// instead. Read path only — nothing about what is SENT changes.
//
// AskUserQuestion is special-cased because the chat otherwise showed only a bare
// "🔧 AskUserQuestion" chip: its tool_use carries a structured `askUserQuestion`
// field (question/header/options+descriptions, per question) instead of the
// generic tool summary, and its tool_result is kept as its own
// `askUserQuestionAnswer` message (normally tool_result entries are dropped as
// mere tool output) — the transcript's OWN record of what was actually
// answered, so the chat never has to trust an unverified client-side echo.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { projectKey } from './subagent-scan.mjs'

const MAX_TOTAL_BYTES = Number(process.env.AGENT_HISTORY_MAX_BYTES || 24 * 1024 * 1024)
const MAX_MESSAGES = Number(process.env.AGENT_HISTORY_MAX_MESSAGES || 4000)
const MAX_TEXT = Number(process.env.AGENT_HISTORY_MAX_TEXT || 20000) // per-message text cap
// …except the OPENING turn, which is the agent's whole brief: standing preamble +
// retrieved Atlas evidence + the operator's question. Those routinely run past
// MAX_TEXT (the executor's own AGENT_PROMPT_MAX_CHARS ceiling is 50,000 chars),
// and a silently-cut prompt loses its whole evidence section — which reads as
// "retrieval returned nothing" when retrieval was fine. So the first turn gets
// its own, generous cap (4× that ceiling): a real bound, not "no bound", since
// the parse is held in the incremental cache.
const MAX_FIRST_TEXT = Number(process.env.AGENT_HISTORY_MAX_FIRST_TEXT || 200000)

// Cap a message body, marking the cut so a truncated message can never read as a
// complete one. Applied TWICE, deliberately: parseTranscript can only apply the
// outer MAX_FIRST_TEXT bound (it sees one chunk of one file, so it cannot know
// which message is the session's first — see the incremental cache and the
// resume-fork stitch below), and stitchParsed, which does see the whole ordered
// history, clamps everything but the opening turn back down to MAX_TEXT.
function capText(s, max) {
  return s.length > max ? s.slice(0, max) + '\n… [truncated]' : s
}

// Fingerprint of a prompt's text, used to match an Atlas-injected steer back to
// the user turn it produced in the transcript. Whitespace-normalized so a
// send-keys newline quirk can't defeat the match. Shared with agent-local.mjs,
// which records this key at steer time (recordSteer).
export function steerKey(text) {
  return crypto
    .createHash('sha1')
    .update(String(text).replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 16)
}

// One entry of a session's recorded steer set. Historically (and on the bridge)
// an entry is the bare fingerprint of an ATLAS steer; a message from another
// AGENT records `<source>:<fingerprint>` instead, so the same set carries WHO
// injected the turn and not just that someone did. Bare entries keep meaning
// 'atlas', which is what makes old persisted state and the bridge's own
// recordSteer keep working unchanged.
export function steerEntry(key, source) {
  return source && source !== 'atlas' ? `${source}:${key}` : key
}

// fingerprint → source, parsed off the recorded entries above.
function steerSources(steerSet) {
  const out = new Map()
  for (const e of steerSet) {
    const s = String(e)
    const i = s.indexOf(':')
    if (i > 0) out.set(s.slice(i + 1), s.slice(0, i))
    else out.set(s, 'atlas')
  }
  return out
}

// Mark user turns an Atlas orchestrator or a peer agent injected (not the
// operator) — the injected prompt lands as an ordinary user turn, so we match it
// back by the fingerprint set recorded at steer time. Mutates `messages` in place
// (they're fresh stitchParsed objects, cached under a rev that includes the steer
// set). Exported so the workstation bridge tags its container-transcript history
// the same way the box tags its own.
export function tagSteered(messages, steerSet) {
  const sources = steerSources(steerSet)
  for (const m of messages) {
    if (m.role !== 'user') continue
    const source = sources.get(steerKey(m.text))
    if (source) m.source = source
  }
}

// One-line summary of a tool call from its input (best-effort, never throws).
function toolSummary(input) {
  if (!input || typeof input !== 'object') return ''
  const pick = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'description', 'prompt', 'old_string']
  const clean = (v) => v.replace(/\s+/g, ' ').trim().slice(0, 140)
  for (const k of pick) if (typeof input[k] === 'string' && input[k].trim()) return clean(input[k])
  const first = Object.values(input).find((v) => typeof v === 'string' && v.trim())
  return typeof first === 'string' ? clean(first) : ''
}

// The agent-control MCP tools that put WORDS into another agent's session, and
// which input key holds them. Two groups, deliberately:
//   • an authored brief — the orchestrator's OWN instruction, passed as a tool
//     argument (`text`/`task`), which is what the operator is accountable for
//     and what must become readable;
//   • no `field` — the words are composed SERVER-SIDE from a fixed template
//     (ship prompt, recap prompt), so there is no argument to render; these
//     still get an outbound entry, without text, so the chat says what was sent
//     instead of showing a bare id.
// Keyed by the bare tool name: the MCP prefix (`mcp__<server>__`) is a
// deployment detail, so recognition is by suffix (see outboundOf).
const OUTBOUND_TOOLS = new Map([
  ['prompt_agent', { kind: 'prompt', field: 'text' }],
  ['queue_agent', { kind: 'queue', field: 'text' }],
  ['interrupt_agent', { kind: 'interrupt', field: 'text' }], // text is optional — observed absent
  ['spawn_agent', { kind: 'spawn', field: 'task' }],
  ['ship_agent', { kind: 'ship', field: null }],
  ['kill_agent', { kind: 'kill', field: null }],
  ['cleanup_agent', { kind: 'cleanup', field: null }],
])

// The structured outbound record of one such call, or null for any other tool.
// `text` is the argument BYTE-EXACT — never reflowed, never trimmed: a brief is
// headings and bullets, and normalizing its whitespace is exactly the damage
// this fixes. Capped at MAX_TEXT like a message body, with the cut marked so a
// truncated brief can never read as a complete one.
function outboundOf(name, input) {
  const spec = OUTBOUND_TOOLS.get(String(name).split('__').pop())
  if (!spec) return null
  const inp = input && typeof input === 'object' ? input : {}
  const out = { kind: spec.kind }
  if (typeof inp.id === 'string' && inp.id) out.target = inp.id
  if (typeof inp.repo === 'string' && inp.repo) out.repo = inp.repo
  let text = spec.field && typeof inp[spec.field] === 'string' ? inp[spec.field] : ''
  if (text.length > MAX_TEXT) {
    text = text.slice(0, MAX_TEXT)
    out.truncated = true
  }
  if (text) out.text = text
  return out
}

// AskUserQuestion's input is `{ questions: [...] }` — an array, so toolSummary
// above finds no string field and the chip renders as a bare "🔧
// AskUserQuestion" with no hint of what was asked: the operator scrolling the
// chat never sees the question, the options, or the answer, even though the
// transcript holds all of it. Pass the real question/header/options/descriptions
// through structured instead, so the client can render an actual question block.
function askUserQuestionOf(input) {
  const questions = input && Array.isArray(input.questions) ? input.questions : []
  return {
    questions: questions.map((q) => ({
      question: String(q?.question || ''),
      ...(q?.header ? { header: String(q.header) } : {}),
      ...(q?.multiSelect ? { multiSelect: true } : {}),
      options: Array.isArray(q?.options)
        ? q.options.map((o) => ({ label: String(o?.label || ''), ...(o?.description ? { description: String(o.description) } : {}) }))
        : [],
    })),
  }
}

// Parse one `.jsonl` file's TEXT into ordered chat messages. Pure (no fs). Returns
// { sessionId, firstTs, messages:[{role,ts,text,tools,uuid}], assistantCount }.
export function parseTranscript(text) {
  const messages = []
  let sessionId = null
  let firstTs = null
  let assistantCount = 0
  // AskUserQuestion tool_use ids seen so far in THIS file, so that when its
  // tool_result later shows up (normally dropped below as mere tool output) we
  // recognize it as the authoritative resolved answer and keep it.
  const askToolIds = new Set()
  for (const line of String(text).split('\n')) {
    if (!line) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue // partial/corrupt line (e.g. a byte-tail cut mid-line) — skip
    }
    if (e.sessionId && !sessionId) sessionId = e.sessionId
    if (e.isSidechain) continue // sub-agent lines aren't the operator conversation
    // A message delivered MID-TURN (boundary delivery) is NEVER recorded as a
    // `user` turn: Claude Code writes it as a `queued_command` attachment when
    // the running turn CONSUMES it. Emit it as the ordinary user turn it is — it
    // has a real uuid, so stitchParsed's dedup still holds — and flag it `queued`
    // so stitchParsed can put it back in send order (the line is appended at
    // consumption time, hence out of ascending-ts order in the file).
    // Two neighbours deliberately stay dropped by the guard below:
    //   • the `queue-operation` enqueue/remove pair — same text (a second bubble)
    //     and NO uuid, so it could never be deduped against this one;
    //   • `commandMode:'task-notification'` — the harness telling the agent a
    //     background task finished, not operator speech.
    const att = e.type === 'attachment' ? e.attachment : null
    if (att && att.type === 'queued_command' && att.commandMode === 'prompt') {
      let queuedText = String(att.prompt || '').trim()
      if (!queuedText) continue
      queuedText = capText(queuedText, MAX_FIRST_TEXT) // clamped to MAX_TEXT in stitchParsed
      const qts = att.timestamp || e.timestamp || null
      if (qts && !firstTs) firstTs = qts
      messages.push({ role: 'user', ts: qts, text: queuedText, tools: [], uuid: e.uuid || null, queued: true })
      continue
    }
    if (e.type !== 'user' && e.type !== 'assistant') continue // drop metadata entries
    const m = e.message
    if (!m) continue
    const c = m.content
    let out = ''
    const tools = []
    let isToolResult = false
    let askAnswer = null // this user entry's tool_result resolves a pending AskUserQuestion
    if (typeof c === 'string') {
      out = c
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && typeof b.text === 'string') out += (out ? '\n' : '') + b.text
        else if (b.type === 'tool_use' && b.name === 'AskUserQuestion') {
          if (b.id) askToolIds.add(b.id)
          tools.push({ name: b.name, summary: '', askUserQuestion: askUserQuestionOf(b.input) })
        } else if (b.type === 'tool_use') {
          const name = String(b.name || 'tool')
          const outbound = outboundOf(name, b.input)
          // Summary unchanged for every tool — the outbound block is additive,
          // so nothing that already rendered can regress.
          tools.push({ name, summary: toolSummary(b.input), ...(outbound ? { outbound } : {}) })
        } else if (b.type === 'tool_result') {
          isToolResult = true
          if (b.tool_use_id && askToolIds.has(b.tool_use_id)) {
            const tr = e.toolUseResult
            askAnswer = {
              toolUseId: b.tool_use_id,
              outcome: tr && typeof tr === 'object' && tr.answers ? 'answered' : 'declined',
              ...(tr && typeof tr === 'object' && tr.answers ? { answers: tr.answers } : {}),
            }
          }
        }
      }
    }
    if (e.type === 'user' && askAnswer) {
      // The permanent, authoritative record of what the operator actually
      // answered (or declined) — kept even though it's a tool_result (normally
      // dropped below), since it's the ONLY place the real resolution lives.
      const ts = e.timestamp || null
      if (ts && !firstTs) firstTs = ts
      messages.push({ role: 'user', ts, text: '', tools: [], uuid: e.uuid || null, askUserQuestionAnswer: askAnswer })
      continue
    }
    // A user-role entry that only carries a tool_result is tool OUTPUT, not a turn;
    // isMeta entries are system-injected. Neither belongs in the conversation.
    if (e.type === 'user' && (isToolResult || e.isMeta)) continue
    out = out.trim()
    if (!out && !tools.length) continue
    out = capText(out, MAX_FIRST_TEXT) // outer bound only — stitchParsed clamps non-opening turns to MAX_TEXT
    const ts = e.timestamp || null
    if (ts && !firstTs) firstTs = ts
    if (e.type === 'assistant') assistantCount++
    messages.push({ role: e.type, ts, text: out, tools, uuid: e.uuid || null })
  }
  return { sessionId, firstTs, messages, assistantCount }
}

// Put mid-turn `queued` messages (see parseTranscript) back where they were SENT.
// Stable insertion by timestamp: the enqueue time is the moment the operator (or
// an orchestrator) actually sent it, which is the position they scroll to looking
// for it — and unlike splicing after the entry `parentUuid` names, it doesn't
// depend on a parent the parser may itself have dropped (it points at a
// tool_result). This lives here, not in parseTranscript, because parseTranscript
// only ever sees ONE chunk: the incremental cache (parseAppended + mergeParsed)
// can hand it the attachment in a later chunk than the turns it belongs among.
// stitchParsed sees the whole accumulated session, so it is the only place the
// placement is always correct.
function placeQueued(messages) {
  if (!messages.some((m) => m.queued)) return messages
  const at = (m) => (m.ts ? Date.parse(m.ts) : NaN) // parse, so mixed ISO precision still orders right
  const out = messages.filter((m) => !m.queued)
  for (const q of messages.filter((m) => m.queued)) {
    const t = at(q)
    // Before the first message stamped strictly later; equal stamps keep file
    // order, so several queued messages at one instant stay in send order.
    let i = Number.isNaN(t) ? -1 : out.findIndex((m) => at(m) > t)
    if (i < 0) i = out.length
    out.splice(i, 0, q)
  }
  return out
}

// Stitch several parsed files into one ordered, deduped history. Pure.
// `parsed`: array of parseTranscript() results.
export function stitchParsed(parsed) {
  // Drop stubs: files with no assistant message (aborted spawns / metadata-only).
  const real = parsed.filter((p) => p.assistantCount > 0 && p.messages.length)
  // Order sessions by their first timestamp and keep each session's messages
  // contiguous, so a conversation reads coherently rather than interleaving forks.
  real.sort((a, b) => String(a.firstTs || '').localeCompare(String(b.firstTs || '')))
  const seen = new Set()
  let messages = []
  for (const p of real) {
    for (const m of placeQueued(p.messages)) {
      if (m.uuid && seen.has(m.uuid)) continue // dedup any resume replay (rare)
      if (m.uuid) seen.add(m.uuid)
      messages.push({
        role: m.role,
        ts: m.ts,
        text: m.text,
        tools: m.tools,
        ...(m.askUserQuestionAnswer ? { askUserQuestionAnswer: m.askUserQuestionAnswer } : {}),
      })
    }
  }
  // The OPENING turn keeps its full text (up to MAX_FIRST_TEXT, applied at parse);
  // every other message is clamped to MAX_TEXT here. This is the only place that
  // knows which message is first: parseTranscript sees one chunk of one file (the
  // incremental cache hands it appended bytes), and a dev agent's history is
  // stitched across resume-forked files — so "first message of this chunk" is
  // wrong in both directions, while this list is the whole ordered conversation.
  // Decided BEFORE the message-count slice below, so a very long chat that drops
  // its opening turn doesn't promote some later message into the generous cap.
  for (let i = 1; i < messages.length; i++) messages[i].text = capText(messages[i].text, MAX_TEXT)
  if (messages.length && messages[0].role !== 'user') messages[0].text = capText(messages[0].text, MAX_TEXT)
  // Over the cap, keep the most RECENT messages (what the truncation note
  // promises): the chat view follows the tail — dropping the tail would freeze
  // a very long conversation at its start.
  const truncated = messages.length > MAX_MESSAGES
  if (truncated) messages = messages.slice(-MAX_MESSAGES)
  return { messages, sessions: real.length, truncated }
}

// Which files to read for an agent, given its worktree / pinned session / kind.
function selectFiles(dir, sessionId, kind) {
  let names
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }
  // Shared-cwd chats (the vault dir is shared by many unrelated chats) → restrict
  // to the pinned session file. Without a pinned id we can't attribute, so bail.
  if (kind === 'knowledge') {
    if (!sessionId) return []
    const f = `${sessionId}.jsonl`
    return names.includes(f) ? [path.join(dir, f)] : []
  }
  // Unique-worktree agents: the dir is 1:1 with the agent — take everything.
  return names.map((f) => path.join(dir, f))
}

/* --- incremental read cache -------------------------------------------- *
 * The `.jsonl` transcripts are APPEND-ONLY (a resume forks a NEW file; existing
 * files are never rewritten), so the chat view's live poll must not re-read
 * multi-MB files every few seconds: per directory we cache each file's parse
 * plus how many bytes of it are consumed (always ending at a line boundary),
 * and later calls parse only the appended bytes. `rev` fingerprints the file
 * set + sizes — when it matches the rev a caller sends back, the route answers
 * `unchanged` without re-serializing the payload. AGENT_HISTORY_CACHE=off
 * restores the cold full-read-per-call behavior as a safety valve.
 */
const CACHE_OFF = process.env.AGENT_HISTORY_CACHE === 'off'
const CACHE_DIRS = Number(process.env.AGENT_HISTORY_CACHE_DIRS || 16)
const cache = new Map() // key → { rev, files: Map<path, {bytes, parsed}>, result }

function revOf(stats, steerSet) {
  // Sorted so the fingerprint is independent of readdir order.
  const sig = stats
    .map(({ p, size }) => `${path.basename(p)}:${size}`)
    .sort()
    .join('|')
  // Fold the steer set in too, so a newly-recorded steer invalidates the cache
  // and re-tags — even when it matched a turn already on disk.
  const steerSig = steerSet && steerSet.size ? [...steerSet].sort().join(',') : ''
  return crypto.createHash('sha1').update(`${sig}||${steerSig}`).digest('hex').slice(0, 16)
}

const emptyParsed = () => ({ sessionId: null, firstTs: null, messages: [], assistantCount: 0 })

// Merge a newly parsed appended chunk into a file's accumulated parse. Pure.
export function mergeParsed(base, add) {
  return {
    sessionId: base.sessionId || add.sessionId,
    firstTs: base.firstTs || add.firstTs,
    messages: base.messages.concat(add.messages),
    assistantCount: base.assistantCount + add.assistantCount,
  }
}

// Read [from, size) of a file and parse it up to the last COMPLETE line — a
// line mid-write must not be consumed, or its message would be lost for good
// (the next poll starts after the consumed bytes). Returns the parse plus how
// many bytes were actually consumed (0 when no complete line landed yet).
function parseAppended(p, from, size) {
  let buf = Buffer.alloc(size - from)
  const fd = fs.openSync(p, 'r')
  let n = 0
  try {
    n = fs.readSync(fd, buf, 0, buf.length, from)
  } finally {
    fs.closeSync(fd)
  }
  buf = buf.subarray(0, n)
  const lastNl = buf.lastIndexOf(0x0a)
  if (lastNl < 0) return { parsed: emptyParsed(), bytes: 0 }
  return { parsed: parseTranscript(buf.subarray(0, lastNl + 1).toString('utf-8')), bytes: lastNl + 1 }
}

// fs entry point: read + stitch an agent's full history from its `.jsonl` file(s).
// Adds `rev` (opaque fingerprint of the file set + sizes) to the result so
// callers can poll cheaply.
export function readHistory({ worktree, sessionId, kind, steered }) {
  if (!worktree) return { messages: [], sessions: 0, truncated: false, rev: '' }
  const dir = path.join(os.homedir(), '.claude', 'projects', projectKey(worktree))
  const files = selectFiles(dir, sessionId, kind)
  const stats = files
    .map((p) => {
      try {
        const st = fs.statSync(p)
        return { p, size: st.size, m: st.mtimeMs }
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const steerSet = new Set(Array.isArray(steered) ? steered : [])
  const rev = revOf(stats, steerSet)
  const key = `${dir} ${kind === 'knowledge' ? sessionId : '*'}`
  if (CACHE_OFF) cache.delete(key)
  const prev = cache.get(key)
  if (prev && prev.rev === rev) {
    cache.delete(key) // LRU refresh
    cache.set(key, prev)
    return prev.result
  }
  // A directory past the byte budget can't be held incrementally without the
  // cache growing unbounded — fall back to cold reads (the pre-cache behavior,
  // bounded per call) and don't cache. Real agent dirs stay well under this.
  const total = stats.reduce((a, s) => a + s.size, 0)
  const cacheable = !CACHE_OFF && total <= MAX_TOTAL_BYTES
  const prevFiles = (cacheable && prev?.files) || new Map()
  const nextFiles = new Map()
  // Budget the NEWEST files first (stitchParsed re-orders by timestamp anyway):
  // when a dir is over budget it's the OLDEST sessions that drop, matching the
  // keep-the-most-recent truncation semantics above.
  stats.sort((a, b) => b.m - a.m)
  let budget = MAX_TOTAL_BYTES
  for (const { p, size } of stats) {
    const had = prevFiles.get(p)
    try {
      if (had && size === had.bytes) {
        nextFiles.set(p, had) // unchanged file — reuse its parse untouched
      } else if (had && size > had.bytes) {
        // Grown file: parse only the appended bytes and merge.
        const { parsed, bytes } = parseAppended(p, had.bytes, size)
        nextFiles.set(p, { bytes: had.bytes + bytes, parsed: mergeParsed(had.parsed, parsed) })
      } else {
        // New (or shrunk/replaced — shouldn't happen) file: cold read under the
        // remaining budget; oversized keeps the tail, like before the cache.
        if (budget <= 0) continue
        const start = size > budget ? size - budget : 0
        const { parsed, bytes } = parseAppended(p, start, size)
        budget -= size - start
        nextFiles.set(p, { bytes: start + bytes, parsed })
      }
    } catch {
      continue // file vanished between stat and read — next poll re-syncs
    }
  }
  const stitched = stitchParsed([...nextFiles.values()].map((f) => f.parsed))
  if (steerSet.size) tagSteered(stitched.messages, steerSet)
  const result = { ...stitched, rev }
  if (cacheable) {
    cache.set(key, { rev, files: nextFiles, result })
    while (cache.size > CACHE_DIRS) cache.delete(cache.keys().next().value)
  }
  return result
}
