/* ------------------------------------------------------------------ *
 * Sub-agent detection from Claude Code transcripts — shared by the
 * box-local dev-agent executor (agent-local.mjs) and the research queue
 * (capture/research-run.mjs). A transcript lives at
 * ~/.claude/projects/<cwd-with-every-non-alnum-as-dash>/<session-id>.jsonl;
 * each sub-agent the session spawns via the Task/Agent tool is a `tool_use`
 * block in an assistant turn, RUNNING until a matching `tool_result` comes
 * back. We tail-read (bounded cost on multi-MiB transcripts), snapshot what
 * the tail shows, and fold snapshots into a persistent per-run list so
 * finished sub-agents stay visible (struck through) instead of vanishing
 * when they scroll out of the tail.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// How a working dir maps to its ~/.claude/projects/ transcript dir.
export function projectKey(dir) {
  return String(dir).replace(/[^a-zA-Z0-9]/g, '-')
}

// Absolute transcript path for a session pinned with `--session-id`.
export function transcriptPath(cwd, sessionId) {
  return path.join(os.homedir(), '.claude', 'projects', projectKey(cwd), `${sessionId}.jsonl`)
}

// Tail-read a transcript: the last `tailBytes` of the file, split into lines.
// The slice may cut the first line mid-JSON; it simply fails to parse later,
// which is harmless. Returns null if the file isn't readable (yet).
export function tailLines(file, tailBytes) {
  try {
    const size = fs.statSync(file).size
    const start = Math.max(0, size - tailBytes)
    const len = size - start
    const buf = Buffer.alloc(len)
    const fd = fs.openSync(file, 'r')
    try {
      fs.readSync(fd, buf, 0, len, start)
    } finally {
      fs.closeSync(fd)
    }
    return buf.toString('utf-8').split('\n')
  } catch {
    return null
  }
}

// One tail snapshot: `seen` (every Task/Agent tool_use in the tail, in order,
// with its label) and `activeIds` (those without a result yet). "Task" is the
// historical name of the sub-agent tool, "Agent" the current one — match both.
export function collectSubAgents(lines) {
  const order = []
  const labels = new Map()
  const spawnedIds = new Set()
  const done = new Set()
  for (const raw of lines) {
    const line = raw.trim()
    if (line[0] !== '{') continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    const content = ev && ev.message && ev.message.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b && b.type === 'tool_use' && (b.name === 'Task' || b.name === 'Agent') && b.id) {
        if (!labels.has(b.id)) {
          const inp = b.input || {}
          const label = String(inp.description || inp.subagent_type || inp.prompt || 'sub-agent')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 48)
          labels.set(b.id, label)
          order.push(b.id)
        }
        spawnedIds.add(b.id)
      } else if (b && b.type === 'tool_result' && b.tool_use_id) {
        done.add(b.tool_use_id)
      }
    }
  }
  const seen = order.map((id) => ({ id, label: labels.get(id) }))
  // Active = its tool_use is in this tail AND no result yet. A Task whose tool_use
  // has scrolled out of the tail is, by definition, one the parent moved past —
  // so it's not in `activeIds` and the merge will mark it finished.
  const activeIds = new Set([...spawnedIds].filter((id) => !done.has(id)))
  return { seen, activeIds }
}

// Context-window fill from a transcript tail: scan from the end for the most
// recent `assistant` turn carrying a token `usage` block, and return its INPUT
// side (input + cache_read + cache_creation) — exactly the prompt Claude just
// processed, ≈ the current context fill. Returns 0 when no usage is in the tail
// (no turn yet, or it scrolled out). The caller pairs this with the model's
// window to render the meter. Shared so the box-local executor and the bridge
// (reading a container transcript) derive the number identically.
export function scanContextTokens(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line[0] !== '{') continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    const u = ev && ev.type === 'assistant' && ev.message && ev.message.usage
    if (!u) continue
    const tokens =
      (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
    if (tokens > 0) return tokens
  }
  return 0
}

/* ------------------------------------------------------------------ *
 * Ship-state markers — the dev-agent preamble asks the agent to print, each on
 * a line of its own, `ATLAS:READY-TO-SHIP` when it judges its branch mergeable
 * and `ATLAS:SHIPPED <PR + SHA>` after it merged its PR. Scanned from ASSISTANT
 * text only (the instructions live in user-side events, so they can't match) and
 * the LATEST marker wins, so shipped → new task → ready flips the state back.
 * Shared by the box-local executor (agent-local.mjs) and the bridge, which scans
 * workstation transcripts the SAME way — so a workstation dev agent carries the
 * same `shipState`/`shipInfo` as a box-local one (needs the on-disk transcript).
 * ------------------------------------------------------------------ */
const SHIP_MARKER = /^[ \t]*ATLAS:(READY-TO-SHIP|SHIPPED)\b([^\n]*)$/gm
function lastShipMarker(text) {
  let found = null
  SHIP_MARKER.lastIndex = 0
  let m
  while ((m = SHIP_MARKER.exec(text))) {
    found = { state: m[1] === 'SHIPPED' ? 'shipped' : 'ready', info: (m[2] || '').trim() }
  }
  return found
}
// The newest ship marker in a transcript tail (assistant text only), or null.
export function scanShipMarker(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line[0] !== '{') continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (!ev || ev.type !== 'assistant') continue
    const content = ev.message && ev.message.content
    if (!Array.isArray(content)) continue
    let found = null
    for (const b of content) {
      if (b && b.type === 'text' && typeof b.text === 'string') {
        found = lastShipMarker(b.text) || found
      }
    }
    if (found) return found
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Background-job detection — the other thing a dev agent can launch from a
 * transcript: a Bash tool_use with `run_in_background: true` (a detached
 * process, e.g. a long crawl), not a delegated sub-agent. Two transcript
 * surfaces carry its lifecycle:
 *   • spawn — the tool_use block itself (label = the agent's `description`,
 *     falling back to the command). Its tool_result arrives IMMEDIATELY (it's
 *     just the task handle), so "no result yet = active" can't work here.
 *   • completion — the harness fires a <task-notification> XML block carrying
 *     <tool-use-id> + <status>completed|failed</status>. It rides several
 *     event containers (queue-operation, attachment, user message), so it's
 *     matched on the RAW line rather than walking each container shape.
 * Unlike sub-agents, status must be STICKY: the spawn scrolls out of the tail
 * long before a day-long job ends, so a job stays 'running' until a
 * notification flips it to 'done'/'failed' — never recomputed from tail
 * presence.
 * ------------------------------------------------------------------ */
const NOTIF_RE = /<task-notification>[\s\S]*?<\/task-notification>/g

// One tail snapshot: `seen` (every backgrounded Bash tool_use in the tail, in
// order, with its label) and `status` (tool_use id → terminal status, from any
// completion notifications in the tail). A notification whose spawn already
// scrolled out still carries the job's description in its <summary>, so late
// discovery keeps a usable label.
export function collectBackgroundJobs(lines) {
  const seen = []
  const ids = new Set()
  const status = new Map()
  for (const raw of lines) {
    const line = raw.trim()
    if (line[0] !== '{') continue
    NOTIF_RE.lastIndex = 0
    let nm
    while ((nm = NOTIF_RE.exec(line))) {
      // The block sits inside a JSON string — unescape before sub-matching.
      const xml = nm[0].replace(/\\n/g, '\n').replace(/\\"/g, '"')
      const tu = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(xml)
      const st = /<status>(\w+)<\/status>/.exec(xml)
      if (!tu || !st) continue
      status.set(tu[1], st[1] === 'completed' ? 'done' : 'failed')
      if (!ids.has(tu[1])) {
        const sum = /Background command "([^"]*)"/.exec(xml)
        if (sum) {
          ids.add(tu[1])
          seen.push({ id: tu[1], label: jobLabel(sum[1]) })
        }
      }
    }
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    const content = ev && ev.message && ev.message.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (
        b && b.type === 'tool_use' && b.name === 'Bash' && b.id && !ids.has(b.id) &&
        b.input && b.input.run_in_background === true
      ) {
        ids.add(b.id)
        seen.push({ id: b.id, label: jobLabel(b.input.description || b.input.command) })
      }
    }
  }
  return { seen, status }
}

function jobLabel(text) {
  return String(text || 'background job').replace(/\s+/g, ' ').trim().slice(0, 48)
}

// Fold a background-job snapshot into a persistent per-session log (array of
// { id, label, status, sub? }, mutated in place, capped). New jobs join as
// 'running'; a terminal status from a notification is applied once and sticks.
// `sub` (set by the caller on snapshot entries) is the Task/Agent tool_use id
// of the sub-agent that spawned the job — carried over, and back-filled onto
// an entry first seen without attribution (a job can surface agent-owned via
// a quoted notification before its owning sub-agent's transcript is scanned).
// Returns whether anything changed (to gate persistence).
export function mergeBackgroundJobLog(log, snap) {
  if (!snap) return false
  const byId = new Map(log.map((e) => [e.id, e]))
  let changed = false
  for (const j of snap.seen) {
    const e = byId.get(j.id)
    if (!e) {
      const n = { id: j.id, label: j.label, status: 'running', ...(j.sub ? { sub: j.sub } : {}) }
      log.push(n)
      byId.set(j.id, n)
      changed = true
    } else if (j.sub && !e.sub) {
      e.sub = j.sub
      changed = true
    }
  }
  for (const [id, st] of snap.status) {
    const e = byId.get(id)
    if (e && e.status !== st) {
      e.status = st
      changed = true
    }
  }
  if (log.length > 64) {
    log.splice(0, log.length - 64)
    changed = true
  }
  return changed
}

// Fold a tail snapshot into a persistent sub-agent log (array of
// { id, label, done }, mutated in place, capped). `done` is recomputed every
// merge from the live tail's activeIds, so a sub-agent reliably flips to
// finished and never gets stuck "active". Returns whether anything changed
// (to gate persistence).
export function mergeSubAgentLog(log, snap) {
  if (!snap) return false
  const byId = new Map(log.map((e) => [e.id, e]))
  let changed = false
  for (const sp of snap.seen) {
    if (!byId.has(sp.id)) {
      const e = { id: sp.id, label: sp.label, done: !snap.activeIds.has(sp.id) }
      log.push(e)
      byId.set(sp.id, e)
      changed = true
    }
  }
  for (const e of log) {
    const nowDone = !snap.activeIds.has(e.id)
    if (e.done !== nowDone) {
      e.done = nowDone
      changed = true
    }
  }
  if (log.length > 64) {
    log.splice(0, log.length - 64)
    changed = true
  }
  return changed
}
