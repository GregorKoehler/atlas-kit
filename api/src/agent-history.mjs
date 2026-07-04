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

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { projectKey } from './subagent-scan.mjs'

const MAX_TOTAL_BYTES = Number(process.env.AGENT_HISTORY_MAX_BYTES || 24 * 1024 * 1024)
const MAX_MESSAGES = Number(process.env.AGENT_HISTORY_MAX_MESSAGES || 4000)
const MAX_TEXT = Number(process.env.AGENT_HISTORY_MAX_TEXT || 20000) // per-message text cap

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

// Mark user turns an Atlas orchestrator injected (not the operator) — the
// injected prompt lands as an ordinary user turn, so we match it back by the
// fingerprint set recorded at steer time. Mutates `messages` in place (they're
// fresh stitchParsed objects, cached under a rev that includes the steer set).
// Exported so the workstation bridge tags its container-transcript history the
// same way the box tags its own.
export function tagSteered(messages, steerSet) {
  for (const m of messages) {
    if (m.role === 'user' && steerSet.has(steerKey(m.text))) m.source = 'atlas'
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

// Parse one `.jsonl` file's TEXT into ordered chat messages. Pure (no fs). Returns
// { sessionId, firstTs, messages:[{role,ts,text,tools,uuid}], assistantCount }.
export function parseTranscript(text) {
  const messages = []
  let sessionId = null
  let firstTs = null
  let assistantCount = 0
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
    if (e.type !== 'user' && e.type !== 'assistant') continue // drop metadata entries
    const m = e.message
    if (!m) continue
    const c = m.content
    let out = ''
    const tools = []
    let isToolResult = false
    if (typeof c === 'string') {
      out = c
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && typeof b.text === 'string') out += (out ? '\n' : '') + b.text
        else if (b.type === 'tool_use') tools.push({ name: String(b.name || 'tool'), summary: toolSummary(b.input) })
        else if (b.type === 'tool_result') isToolResult = true
      }
    }
    // A user-role entry that only carries a tool_result is tool OUTPUT, not a turn;
    // isMeta entries are system-injected. Neither belongs in the conversation.
    if (e.type === 'user' && (isToolResult || e.isMeta)) continue
    out = out.trim()
    if (!out && !tools.length) continue
    if (out.length > MAX_TEXT) out = out.slice(0, MAX_TEXT) + '\n… [truncated]'
    const ts = e.timestamp || null
    if (ts && !firstTs) firstTs = ts
    if (e.type === 'assistant') assistantCount++
    messages.push({ role: e.type, ts, text: out, tools, uuid: e.uuid || null })
  }
  return { sessionId, firstTs, messages, assistantCount }
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
    for (const m of p.messages) {
      if (m.uuid && seen.has(m.uuid)) continue // dedup any resume replay (rare)
      if (m.uuid) seen.add(m.uuid)
      messages.push({ role: m.role, ts: m.ts, text: m.text, tools: m.tools })
    }
  }
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
