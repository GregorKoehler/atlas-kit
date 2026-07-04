/* ------------------------------------------------------------------ *
 * Box-local dev/knowledge-agent executor.
 *
 * The optional `agent-bridge/` drives agents in remote dev CONTAINERS via
 * `docker exec` on another machine. This module is its on-box sibling: it spawns
 * agents that work on repos checked out ON THIS BOX (e.g. my-project at
 * /srv/my-project), running `git`/`tmux` DIRECTLY (no docker). Same contract,
 * same worktree-per-agent isolation; it just runs in-process inside the Express
 * API rather than as a separate daemon.
 *
 * ⚠️ This is execution ON the control-plane box. Unlike the container bridge,
 * the worktree isolates the working dir/branch but NOT the box: an agent here
 * runs `claude --dangerously-skip-permissions` with the box's gh push (repo +
 * vault) and subscription. A deliberate, single-operator trade-off. Defenses:
 * an ALLOWLIST (no arbitrary path from the client — the client sends a repo
 * KEY), strict slugs (no user string reaches a shell unescaped), and an
 * append-only audit log. The dashboard's bearer gate fronts spawn/prompt/kill.
 *
 * OPT-IN: enabled only when an allowlist file exists (AGENT_LOCAL_REPOS, default
 * agent-local-repos.json beside this module). Absent/empty → disabled, and any
 * spawn is forwarded to a remote bridge instead (see bridges.mjs).
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  projectKey, tailLines, scanContextTokens, scanShipMarker,
  collectSubAgents, mergeSubAgentLog,
  collectBackgroundJobs, mergeBackgroundJobLog,
} from './subagent-scan.mjs'
import { generateMicros } from './agent-titles.mjs'
import { readHistory, steerKey } from './agent-history.mjs'
import { parseChoiceMenu } from './menu.mjs'
import { resolveVault, defaultVaultKey, isTypedVault } from './vaults.mjs'
import { enqueueAtlasMerge } from './atlas-commit-queue.mjs'
import { trackPhase, recordLifetime, revivePhase, aggregate, PHASE_HOLD_MS } from './agent-timings.mjs'
import {
  S as LC, ACT, decide, applyTransition, migrateSession, mirrorState,
  initLifecycle, isClosing, isInert, QUIESCENT,
} from './agent-lifecycle.mjs'
export { monthRunMsByRepo } from './agent-timings.mjs'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const REPOS_FILE = process.env.AGENT_LOCAL_REPOS || path.join(HERE, 'agent-local-repos.json')
const STATE_DIR = process.env.AGENT_LOCAL_DIR || path.join(os.homedir(), '.atlas-kit')
const STATE_FILE = path.join(STATE_DIR, 'state.json')
const AUDIT_LOG = path.join(STATE_DIR, 'audit.log')
const WORKSPACE = process.env.WORKSPACE_DIR || '/workspace'
// `{model}`/`{effort}` are substituted with the (shell-quoted) per-spawn picks
// the proxy validated. Whether the model carries the `[1m]` extended-context
// suffix is the proxy's call (default-on; see AGENT_EXTENDED_CONTEXT in
// agent-routes.mjs) — the DEFAULT_MODEL below is only a fallback for a direct
// call that omits one, and mirrors the same default. A custom
// AGENT_LOCAL_LAUNCH_CMD without the placeholders simply keeps what it hardcodes.
//
// `env -u ANTHROPIC_API_KEY` forces the agent onto SUBSCRIPTION auth, never
// API-key billing — the same guarantee the `claude -p` workers get by blanking
// the key in their spawn env. It matters here specifically because this is the
// one claude launch that goes through tmux: a new pane can inherit the tmux
// SERVER's global env (see serve.sh), so a stray key could slip in even though
// Express was launched with the key stripped. Belt-and-suspenders against that.
const LAUNCH_CMD =
  process.env.AGENT_LOCAL_LAUNCH_CMD ||
  'IS_SANDBOX=1 env -u ANTHROPIC_API_KEY claude --model {model} --effort {effort} --dangerously-skip-permissions {task}'
// Knowledge agents (vault chats) additionally pin `--session-id {sid}`: they all
// share the vault as cwd, so without a pinned id the transcript reader's
// newest-file heuristic would cross-read between concurrent chats.
const KNOWLEDGE_LAUNCH_CMD =
  process.env.AGENT_KNOWLEDGE_LAUNCH_CMD ||
  'IS_SANDBOX=1 env -u ANTHROPIC_API_KEY claude --model {model} --effort {effort} --session-id {sid} --dangerously-skip-permissions {task}'
// The Atlas ORCHESTRATOR (the vault:'atlas' chat) is a knowledge agent that can
// ALSO spawn/monitor/steer other agents. It loads the Atlas Kit MCP server via
// control.mcp.json, which sets ATLAS_AGENT_CONTROL=1 in the MCP child's env —
// flipping on the agent-control tools in mcp/tools.mjs — and still carries
// query_atlas/query_vault. `--strict-mcp-config` means ONLY that server is used
// (the vault has no .mcp.json of its own; a normal knowledge chat gets no MCP).
const CONTROL_MCP_CONFIG = `${WORKSPACE}/api/src/mcp/control.mcp.json`
// `ATLAS_SESSION={atlasSession}` exports this chat's session id into the
// claude process — and so into its MCP child, which reads it in spawn_agent to
// stamp every agent it spawns with `parent`, drawing the lineage constellation.
const ATLAS_CONTROL_LAUNCH_CMD =
  process.env.AGENT_ATLAS_LAUNCH_CMD ||
  `IS_SANDBOX=1 ATLAS_SESSION={atlasSession} env -u ANTHROPIC_API_KEY claude --model {model} --effort {effort} --session-id {sid} --mcp-config ${CONTROL_MCP_CONFIG} --strict-mcp-config --dangerously-skip-permissions {task}`
// Extended (1M) context is the DEFAULT — the subscription serves the 1M window
// without usage credits for Opus/Fable, so the fallback model + the meter's
// window default to it. AGENT_EXTENDED_CONTEXT=0 (or false/no/off) is the global
// kill-switch back to the standard window. Kept in sync with the proxy's
// resolution in agent-routes.mjs (which also keeps Sonnet on the standard
// window — its 1M variant needs usage credits the subscription lacks).
const EXTENDED_CONTEXT = !/^(0|false|no|off)$/i.test(process.env.AGENT_EXTENDED_CONTEXT || '')
const DEFAULT_MODEL = EXTENDED_CONTEXT ? 'claude-opus-4-8[1m]' : 'claude-opus-4-8'
const DEFAULT_EFFORT = 'xhigh'
const EXEC_TIMEOUT_MS = Number(process.env.AGENT_LOCAL_EXEC_TIMEOUT_MS || 15000)
// Detector window: the bottom rows of the pane the busy/menu scans look at
// (captureTail slices to this). 32 ≈ the effective window the detectors were
// tuned on before panes went tall (24 visible rows + 8 history) — big enough
// that a real menu's `❯ 1. …` highlight and the busy status line are always in
// view, small enough that most of the conversation isn't.
const TAIL_LINES = Number(process.env.AGENT_LOCAL_TAIL_LINES || 32)
// Transcript geometry. Claude Code runs as an ALTERNATE-SCREEN TUI, so its
// conversation never spills into tmux scrollback (`history_size` stays 0) —
// `capture-pane` only ever returns the pane's *visible* rows. A default 80x24
// pane therefore shows just the last ~24 rows (newest message + input box), which
// reads as a truncated history every time the transcript view (re)loads. Growing
// the pane HEIGHT makes Claude re-lay-out far more of its in-memory conversation
// into the visible region, so the expand-transcript capture surfaces it. Width
// stays 80 — the fixed grid the transcript CSS renders against (it can't reflow).
// We grow the pane lazily, only when its transcript is actually fetched (see
// output()), so idle/unwatched agents stay at the cheap default on the RAM-bound box.
const PANE_ROWS = Number(process.env.AGENT_LOCAL_PANE_ROWS || 400)
const PANE_COLS = Number(process.env.AGENT_LOCAL_PANE_COLS || 80)
// Live-app slot: a box-local dev agent runs its web app (Streamlit etc.) the
// dashboard shows beside its transcript. The box reaches it on loopback at this
// fixed port; the agent is told it in its preamble (substituted at spawn). Box-local
// shares this one fixed slot per box — still one app at a time on the box (a known
// follow-up); the workstation bridge gives each session its own port from a band.
const APP_PORT = Number(process.env.AGENT_LOCAL_APP_PORT || 8701)
const APP_PROBE_MS = Number(process.env.AGENT_LOCAL_APP_PROBE_MS || 300)
// Upload limits (the prompt path can carry attached files — see prompt()). The
// `images` wire field is historical; it now carries any file type.
const MAX_IMAGES = Number(process.env.AGENT_MAX_IMAGES || 6)
const MAX_IMAGE_BYTES = Number(process.env.AGENT_MAX_IMAGE_BYTES || 8 * 1024 * 1024)
// Context-window meter: Claude's usable window (tokens) and how much of the
// transcript tail to scan for the latest usage block (assistant events are
// small, so 1 MiB reliably catches the most recent turn even on big sessions).
const CONTEXT_WINDOW = Number(process.env.AGENT_CONTEXT_WINDOW || (EXTENDED_CONTEXT ? 1000000 : 200000))
const CONTEXT_TAIL_BYTES = Number(process.env.AGENT_CONTEXT_TAIL_BYTES || 1024 * 1024)
// Sub-agent transcripts (background-job attribution) get a smaller tail and a
// file cap so the per-poll scan cost stays bounded with many sub-agents.
const SUBAGENT_TAIL_BYTES = Number(process.env.AGENT_SUBAGENT_TAIL_BYTES || 256 * 1024)
const SUBAGENT_SCAN_FILES = Number(process.env.AGENT_SUBAGENT_SCAN_FILES || 12)
// Live-stats files (see sampleLiveStats): caps on what one session may publish.
const MAX_STATS_BYTES = Number(process.env.AGENT_STATS_MAX_BYTES || 64 * 1024)
const MAX_STAT_ENTRIES = Number(process.env.AGENT_STATS_MAX_ENTRIES || 6)
const MAX_STAT_POINTS = Number(process.env.AGENT_STATS_MAX_POINTS || 120)
const MAX_STAT_LABEL = 28
// After an interrupt we send Escape, then wait this long for Claude Code's TUI to
// stop the turn and return to an empty prompt before typing the added context (a
// send too soon races the still-streaming pane). Queued prompts are flushed on a
// timer: each tick, any session that has gone idle (no busy marker, no menu) gets
// its pending prompt delivered — true end-of-turn delivery, independent of the UI.
const INTERRUPT_SETTLE_MS = Number(process.env.AGENT_LOCAL_INTERRUPT_SETTLE_MS || 400)
const QUEUE_FLUSH_MS = Number(process.env.AGENT_LOCAL_QUEUE_FLUSH_MS || 3000)
// A session's queue (`s.queued`) is a FIFO of parked prompts; this caps its depth
// so a stuck/errored agent that never flushes can't grow the persisted state without
// bound. Queueing past the cap is rejected (the card surfaces the error).
const MAX_QUEUED = Number(process.env.AGENT_LOCAL_MAX_QUEUED || 20)
// Concurrency cap (the box is RAM-bound — too many live `claude` agents at once
// OOM'd it on 2026-06-25). Spawns refuse to exceed this many LIVE (tmux-alive)
// `agentbox-` sessions. This is a generous SAFETY CEILING — the real brake is the
// free-RAM gate in atCapacity() (memHeadroom, below), so the count can be high and
// RAM decides. Swap is the cushion. Box-local only; bridge/remote agents run on
// other hosts and are not counted.
const MAX_LIVE = Number(process.env.AGENT_LOCAL_MAX_CONCURRENT || 12)
// Crash self-heal: on boot, re-attach sessions a restart/crash orphaned (entry
// still in the registry — a graceful reap deletes it — but its tmux gone) via
// `claude --resume`, up to the cap, staggered. Kill-switch: 0/false/off. NOTE a
// `serve.sh restart` is session-scoped, so agent tmux SURVIVES it; this only
// fires on a true tmux-server death (reboot/OOM), which is exactly the case.
const RECONCILE = !/^(0|false|no|off)$/i.test(process.env.AGENT_LOCAL_RECONCILE || '1')
// Lifecycle driver kill-switch (0/false/off): when off, the flush timer stops
// advancing the state machine (ship/close/reap). Spawns/kills still mutate state;
// only the autonomous progression pauses. Default on. (Used by tests to keep the
// registry frozen while asserting migration + projection.)
const DRIVE = !/^(0|false|no|off)$/i.test(process.env.AGENT_LOCAL_DRIVE || '1')
const RECONCILE_BOOT_DELAY_MS = Number(process.env.AGENT_LOCAL_RECONCILE_DELAY_MS || 5000)
const RECONCILE_STAGGER_MS = Number(process.env.AGENT_LOCAL_RECONCILE_STAGGER_MS || 4000)
const RECONCILE_MENU_MS = Number(process.env.AGENT_LOCAL_RECONCILE_MENU_MS || 8000)
// Revive memory gate: the box is RAM-bound (the 2026-06-25 OOM froze it), so a
// revive — single or the bulk "Revive all" — only launches while there's room.
// Require FLOOR free PLUS one agent's headroom so the agent we start can grow
// without tipping into OOM. Bulk revive re-checks between each and STOPS (doesn't
// fail) when the box fills, so it brings back as many as safely fit.
const REVIVE_MEM_FLOOR_MB = Number(process.env.AGENT_LOCAL_REVIVE_MEM_FLOOR_MB || 1200)
const REVIVE_MEM_PER_AGENT_MB = Number(process.env.AGENT_LOCAL_REVIVE_MEM_PER_AGENT_MB || 500)
const REVIVE_STAGGER_MS = Number(process.env.AGENT_LOCAL_REVIVE_STAGGER_MS || RECONCILE_STAGGER_MS)
// Resume launch: like LAUNCH_CMD but `--resume {sid}` restores the full session
// (the task/preamble is already in the transcript), so none is re-supplied.
const RESUME_CMD =
  process.env.AGENT_LOCAL_RESUME_CMD ||
  'IS_SANDBOX=1 env -u ANTHROPIC_API_KEY claude --model {model} --effort {effort} --dangerously-skip-permissions --resume {sid}'
// Resume launch for the Atlas ORCHESTRATOR (the vault:'atlas' chat): like RESUME_CMD
// but re-attaches the agent-control MCP config + ATLAS_SESSION, so a revived
// orchestrator gets its spawn/prompt/kill tools back — a plain resume would bring the
// chat back DE-FANGED. Mirrors ATLAS_CONTROL_LAUNCH_CMD with `--resume` in place of
// `--session-id {sid} {task}` (the conversation is already in the transcript).
const ATLAS_CONTROL_RESUME_CMD =
  process.env.AGENT_ATLAS_RESUME_CMD ||
  `IS_SANDBOX=1 ATLAS_SESSION={atlasSession} env -u ANTHROPIC_API_KEY claude --model {model} --effort {effort} --mcp-config ${CONTROL_MCP_CONFIG} --strict-mcp-config --dangerously-skip-permissions --resume {sid}`
// Serial ship train backstop: a member that goes busy and never prints
// ATLAS:SHIPPED is detected as stopped the moment it returns to idle (see
// pumpShipTrain); this only bounds a member that stays wedged-busy forever, so
// one stuck ship can't hold the train indefinitely. Generous — a dashboard ship
// can rebuild/verify before merging.
const SHIP_TURN_TIMEOUT_MS = Number(process.env.AGENT_SHIP_TURN_TIMEOUT_MS || 20 * 60 * 1000)
// How long after delivering the ship prompt to keep waiting for the agent's turn
// to visibly START (the busy marker). If it's idle this whole window without ever
// going busy, advance anyway — covers a ship that failed/no-op'd faster than the
// 3s sampling could catch it busy, so it can't stall the train. Generous enough
// to never trip on a slow first token.
const SHIP_START_GRACE_MS = Number(process.env.AGENT_SHIP_START_GRACE_MS || 60 * 1000)

const nowIso = () => new Date().toISOString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Atlas worker brief: the spawn request BLOCKS up to ATLAS_BRIEF_TIMEOUT_MS for
// the paired worker's first (brief) turn, then launches the dev agent — briefed
// if it finished in time, unbriefed otherwise. Poll interval + a start-grace for
// turns that finish between polls before we catch them busy.
const ATLAS_BRIEF_TIMEOUT_MS = Number(process.env.ATLAS_BRIEF_TIMEOUT_MS || 45000)
const ATLAS_BRIEF_POLL_MS = Number(process.env.ATLAS_BRIEF_POLL_MS || 2500)
const ATLAS_BRIEF_GRACE_MS = Number(process.env.ATLAS_BRIEF_GRACE_MS || 12000)

// POSIX single-quote escaping — safe to embed in an `sh -lc` string.
function shquote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

// Strict slug: lowercase alnum + dashes, bounded. id, branch (agent/<id>), tmux
// name (agentbox-<id>) and worktree leaf all derive from it.
function slugify(task) {
  return String(task)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

// Lowercased filename extension (no dot), or '' if none.
function fileExt(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''))
  return m ? m[1].toLowerCase() : ''
}

// Decode a base64 `data:` URL upload to { ext, buf }, or null if it's empty or
// exceeds the per-file cap. Any file type is accepted — the file is written to
// disk and the agent decides what to do with it (Read tool for images/text). The
// data URL's declared MIME is ignored — types report it inconsistently across
// browsers — so the extension comes from the filename (which may be '' for an
// extensionless file like a Dockerfile).
function decodeUpload(name, dataUrl) {
  const m = /^data:[^,]*?;base64,([\s\S]+)$/.exec(String(dataUrl || ''))
  if (!m) return null
  const ext = fileExt(name)
  const buf = Buffer.from(m[1], 'base64')
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null
  return { ext, buf }
}

// Persist uploaded files for a session OUTSIDE its worktree (so the prod
// checkout's git status stays clean) and return their absolute paths. The agent
// reads them by path via the Read tool — it runs with --dangerously-skip-
// permissions, so any absolute path is readable. Throws on an invalid file.
function saveImages(id, images) {
  const dir = path.join(STATE_DIR, 'uploads', id)
  fs.mkdirSync(dir, { recursive: true })
  const paths = []
  for (let i = 0; i < images.length; i++) {
    const parsed = decodeUpload(images[i] && images[i].name, images[i] && images[i].dataUrl)
    if (!parsed) throw new Error(`file ${i + 1} invalid or too large`)
    const stem = slugify(String((images[i] && images[i].name) || '').replace(/\.[^.]+$/, '')) || `file-${i + 1}`
    const file = path.join(dir, `${Date.now()}-${i}-${stem}${parsed.ext ? `.${parsed.ext}` : ''}`)
    fs.writeFileSync(file, parsed.buf)
    paths.push(file)
  }
  return paths
}

// Fold attached-file paths into a SINGLE-LINE prompt (newlines would submit
// early in the TUI). The agent is told to Read them before responding.
function withImages(text, paths) {
  if (!paths.length) return text
  const noun = paths.length > 1 ? 'files' : 'a file'
  const them = paths.length > 1 ? 'them' : 'it'
  const tail = `[I attached ${noun} at: ${paths.join(', ')} — use the Read tool to view ${them} before responding.]`
  return text ? `${text} ${tail}` : tail
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return fallback
  }
}

// Allowlist of box-local repos: { "<key>": { "path"?, "worktreeBase"? } }.
// `path` defaults to WORKSPACE, `worktreeBase` to a dir OUTSIDE the repo (so the
// prod checkout's git status stays clean). Re-read per call so edits don't need
// an Express restart, mirroring the bridge.
function loadRepos() {
  const repos = readJson(REPOS_FILE, null)
  return repos && typeof repos === 'object' && !Array.isArray(repos) ? repos : {}
}

export function localRepoKeys() {
  return Object.keys(loadRepos())
}
export function isLocalRepo(repo) {
  return Object.prototype.hasOwnProperty.call(loadRepos(), repo)
}
// Whether the box can run Atlas workers at all: box-local execution is on AND the
// `atlas` vault is registered. Gates the paired-worker briefing/ingest — including
// the REMOTE (workstation) close ingest, which agent-routes drives through here.
export function atlasAvailable() {
  return localRepoKeys().length > 0 && !!resolveVault('atlas')
}
// The loopback port a box-local repo's live app is served on (the app-proxy
// reaches it here). One shared slot for the box, so `repo` is accepted for a
// symmetric signature but doesn't vary the port today.
export function appPort(_repo) {
  return APP_PORT
}
// The URL base path the agent serves its app under (Streamlit --server.baseUrlPath)
// and the proxy preserves end-to-end — per-session (`agent-app/<repo>/<id>`) so it
// matches the per-session appPath the card embeds. (The box still has one loopback
// app port; multiple box-local apps at once is a follow-up — workstation containers
// get true per-session ports via the bridge.)
function appBasePath(repo, id) {
  return `agent-app/${repo}/${id}`
}
// Fill the {appAddress}/{appPort}/{appBasePath} tokens an APP_PREAMBLE carries
// with this box-local slot's concrete values (loopback bind, the box app port).
function injectApp(text, repo, id) {
  return text
    .replaceAll('{appAddress}', '127.0.0.1')
    .replaceAll('{appPort}', String(APP_PORT))
    .replaceAll('{appBasePath}', appBasePath(repo, id))
}
// Is something listening on `port` (loopback)? Used to tell the card whether to
// show the app pane. Resolves false on refuse/timeout — never throws.
function probeTcp(port, timeout = APP_PROBE_MS) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeout)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}
// Does this session id belong to the box-local executor? Used by the proxy to
// route prompt/kill (which carry only an id) to the right bridge.
export function hasSession(id) {
  return Object.prototype.hasOwnProperty.call(registry.sessions, id)
}

let registry = readJson(STATE_FILE, { sessions: {} })
if (!registry || typeof registry !== 'object' || !registry.sessions) registry = { sessions: {} }
// Persistent floor for project-card ordering: ISO time of the most recent
// dev-agent spawn per bridge repo. Unlike sessions, an entry here is NEVER
// removed on kill/cleanup, so a project that once ran an agent keeps its
// recency rank even after all its sessions are closed. Keyed by repo for BOTH
// bridges — the router records every spawn here, box-local or workstation.
if (!registry.lastSpawn || typeof registry.lastSpawn !== 'object') registry.lastSpawn = {}
// Serial ship train: an ordered list (FIFO) of dev sessions to ship ONE AT A
// TIME, so several "ready" agents can be queued without racing the shared
// /workspace/.git or landing un-integrated on master (each re-syncs onto the
// prior merge before its own). The ORDER is the serialization; each member is
// just `{ id, text }` — the per-session ship bookkeeping (baseline / promptedAt /
// sawBusy) now lives on `s.lc` (the lifecycle record), and `lc.state === 'shipping'`
// marks the one actively merging. Persisted so an Express restart — e.g. a
// self-deploy mid-train — resumes it; see enqueueShip / the lifecycle driver.
if (
  !registry.shipTrain ||
  typeof registry.shipTrain !== 'object' ||
  !Array.isArray(registry.shipTrain.members)
)
  registry.shipTrain = { members: [] }
// Back-compat: `s.queued` was once a single slot (one object); it's now a FIFO
// array of parked prompts. Normalize any legacy object loaded from STATE_FILE to
// a one-element array so an in-flight queued prompt survives the upgrade.
for (const s of Object.values(registry.sessions)) {
  if (s.queued && !Array.isArray(s.queued)) s.queued = [s.queued]
}

// Lifecycle migration (see agent-lifecycle.mjs): derive each session's `lc` record
// from the LEGACY flags (closing / closePhase / shipState) so sessions spawned
// under the old machine continue cleanly — the "don't strand a mid-close session
// when this deploys" guarantee. Then fold the old ship-train member fields
// (phase / baseline / promptedAt / sawBusy) onto the relevant session's `lc` and
// normalize members to `{ id, text }`.
function migrateRegistry() {
  for (const s of Object.values(registry.sessions)) migrateSession(s)
  const members = registry.shipTrain.members
  for (let i = 0; i < members.length; i++) {
    const m = members[i]
    const s = registry.sessions[m.id]
    if (s && s.lc) {
      s.lc.shipRequested = true
      s.lc.shipText = m.text
      if (m.phase === 'shipping') {
        s.lc.state = LC.SHIPPING
        if (m.baseline != null) s.lc.shipBaseline = m.baseline
        if (m.promptedAt != null) s.lc.shipPromptedAt = new Date(m.promptedAt).toISOString()
        if (m.sawBusy) s.lc.shipSawBusy = true
      }
    }
    members[i] = { id: m.id, text: m.text } // shed the legacy per-member fields
  }
}
migrateRegistry()

// Snapshot which sessions were alive when this process loaded state.json — taken
// HERE, before the first /api/agents poll can flip restart-orphaned ones to
// 'done'. The boot reconciler (reconcileOrphans) revives exactly this set. A
// graceful reap DELETES the entry, so a still-present entry that was last
// running/idle is the durable "meant to be alive" signal — the thin lifecycle
// slice that lets a crash self-heal without a full state machine.
const BOOT_ALIVE = new Set(
  Object.values(registry.sessions)
    .filter((s) => s.status === 'running' || s.status === 'idle')
    .map((s) => s.id),
)

function persist() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(registry, null, 2))
  } catch (e) {
    console.error('[agent-local] persist failed:', e.message)
  }
}

// Stamp `repo`'s last-spawn floor (monotonic — only advances). Called from the
// spawn route after every successful dev-agent spawn, regardless of bridge.
export function recordSpawn(repo, at = nowIso()) {
  if (!repo) return
  const prev = registry.lastSpawn[repo]
  if (!prev || prev < at) {
    registry.lastSpawn[repo] = at
    persist()
  }
}

// Stamp the spawn-time t-shirt size (S/M/L) onto a box-local session — called by
// the proxy once the async title agent classifies the task. Feeds the run-time
// estimator (agent-timings.mjs buckets on size). No-ops for an unknown id (e.g. a
// workstation session, which has no record here) or a size already set.
export function setSize(id, size) {
  if (!size) return
  const s = registry.sessions[id]
  if (!s || s.size === size) return
  s.size = size
  persist()
}

// Snapshot of the last-spawn-per-repo floor for GET /api/agents to ship to the
// project cards (repo key → ISO timestamp).
export function lastSpawnMap() {
  return { ...registry.lastSpawn }
}
function audit(entry) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.appendFileSync(AUDIT_LOG, JSON.stringify({ at: nowIso(), ...entry }) + '\n')
  } catch (e) {
    console.error('[agent-local] audit failed:', e.message)
  }
}

// The spawn-time model/effort picks are stored on the session record (so the
// card can label them), but only since that field landed. Sessions spawned
// before it — still running and reloaded from STATE_FILE across a restart —
// carry no model/effort, so their card silently drops the label after a
// redeploy. Recover the real picks from the spawn audit log (which has always
// recorded them): newest spawn entry per id wins. Runs once at load and
// re-persists, so the gap self-heals for every already-running agent without a
// re-spawn. A session whose spawn predates audited picks just stays unlabelled.
function backfillModelEffort() {
  const need = Object.values(registry.sessions).filter((s) => !s.model || !s.effort)
  if (!need.length) return
  let log
  try {
    log = fs.readFileSync(AUDIT_LOG, 'utf-8')
  } catch {
    return
  }
  const picks = {}
  for (const line of log.split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.action === 'spawn' && e.id && e.model) picks[e.id] = { model: e.model, effort: e.effort }
  }
  let changed = false
  for (const s of need) {
    const p = picks[s.id]
    if (!p) continue
    if (!s.model && p.model) { s.model = p.model; changed = true }
    if (!s.effort && p.effort) { s.effort = p.effort; changed = true }
  }
  if (changed) persist()
}
backfillModelEffort()

// Run a command directly on the box (no docker, no shell): argv is a real arg
// array, so path/branch/text are never shell-interpolated.
function run(argv) {
  return new Promise((resolve) => {
    execFile(
      argv[0],
      argv.slice(1),
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: stdout || '',
          stderr: (stderr || '') + (err && !stderr ? String(err.message) : ''),
        })
      },
    )
  })
}

async function sessionAlive(s) {
  return (await run(['tmux', 'has-session', '-t', s.tmux])).ok
}
async function captureTail(s, lines, ansi = false) {
  // ansi=true adds -e to keep the pane's SGR escapes (for the transcript view,
  // so the client can render Claude Code's faint placeholder muted). The status
  // /menu capture leaves it off so menuKindOf's byte patterns stay clean.
  const flags = ansi ? ['-e', '-p'] : ['-p']
  const r = await run(['tmux', 'capture-pane', '-t', s.tmux, ...flags, '-S', `-${lines}`])
  if (!r.ok) return ''
  // `-S -N` only moves the capture's START into history — the end is always the
  // BOTTOM of the visible pane, so on a pane grown tall (ensurePaneTall) the raw
  // capture is the whole conversation, not a tail. Slice to the last `lines`
  // rows so the busy/menu detectors see only the input-box/footer region they
  // were written for; past `❯ <user message>` echoes higher up must not count.
  const text = r.stdout.replace(/\n+$/, '')
  const rows = text.split('\n')
  return rows.length > lines ? rows.slice(-lines).join('\n') : text
}
// Grow a session's pane to the tall transcript geometry so capture-pane returns
// more of the conversation (see PANE_ROWS). Best-effort and idempotent: we only
// resize when the height differs, so it's a no-op (no SIGWINCH/re-render churn)
// once tall. Returns true when it actually grew the pane — the caller then waits a
// beat for Claude to re-render into the new size before capturing. NOTE a taller
// pane reveals the CONVERSATION above the input box, so every capture-based
// detector must window itself to the pane's bottom rows (captureTail slices to
// its `lines` arg) — an unwindowed scan reads past `❯ <user message>` echoes as
// a menu and quoted "esc to interrupt" text as busy.
async function ensurePaneTall(tmux) {
  const cur = await run(['tmux', 'display-message', '-p', '-t', tmux, '#{pane_height}'])
  if (!cur.ok) return false
  if (Number(cur.stdout.trim()) === PANE_ROWS) return false
  const r = await run(['tmux', 'resize-window', '-t', tmux, '-x', String(PANE_COLS), '-y', String(PANE_ROWS)])
  return r.ok
}
// Claude bottom-anchors its input box, so on a tall pane a conversation shorter
// than PANE_ROWS leaves a large blank gap between the last message and the box —
// pinned to the bottom, the transcript view would open on empty space. Collapse
// any run of blank (visually empty, ANSI aside) lines to at most two, so the
// conversation always sits just above the input box. Normal 1–2 line message
// spacing is preserved.
const SGR_RE = /\x1b\[[0-9;?]*[A-Za-z]/g
export function collapseBlankRuns(text) {
  const out = []
  let blanks = 0
  for (const ln of text.split('\n')) {
    if (ln.replace(SGR_RE, '').trim() === '') {
      if (++blanks <= 2) out.push(ln)
    } else {
      blanks = 0
      out.push(ln)
    }
  }
  return out.join('\n')
}
function lastLine(text) {
  const lines = String(text)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length)
  return lines.length ? lines[lines.length - 1] : ''
}

// Claude Code prints "esc to interrupt" in its status line ONLY while a turn is
// actively running; the moment it finishes and waits for the next prompt that
// marker is gone. So a live tmux session showing it = working ('running'); a
// live one without it = the agent is blocked on YOU ('idle' / needs input).
const BUSY_MARKER = /esc to interrupt/i
export function isBusy(pane) {
  return BUSY_MARKER.test(pane)
}

// Two interactive states the respond toolbar can drive — reported as `menuKind`
// so the card shows only the confirm button that fits (and nothing when merely
// idle-at-the-prompt, where Enter/Escape do nothing):
//   • 'choice' — numbered menus (permission/plan/trust): the highlighted option
//     is marked `❯` + a REGULAR space + the option NUMBER (`❯ 1. Yes`) —
//     confirm with Enter. The number is load-bearing: Claude Code ALSO echoes
//     every past user message as `❯ <text>` with a regular space, so a bare
//     `❯ ` match reads any conversation tail as a phantom menu (which blocked
//     ship/queue delivery forever — the 2026-07-01 "ship hangs" bug). Real
//     choice menus are always numbered (see menu.mjs's parser).
//   • 'complete' — @/ autocomplete dropdowns (file refs, slash commands): the
//     input line is `❯` + a NON-BREAKING space + the typed text carrying a
//     completion token — a LEADING `/` (slash command) or an `@` ref ANYWHERE
//     on the line (e.g. "fix bug in @src/x"). Pick the highlighted item with
//     Tab, THEN Enter to submit (the card's "insert & send"; Enter alone
//     wouldn't insert). Anchored to `❯`+NBSP so a stray `@`/`/` elsewhere on
//     screen (e.g. the email in the welcome header) can't match.
// The two `❯` glyphs are identical (U+276F); the trailing space differs (0x20
// vs U+00A0), which also lets the ordinary ready-prompt (`❯`+NBSP+plain text)
// match NEITHER — so it correctly reports no menu.
const MENU_MARKER = /(^|\n)\s*❯ +\d{1,2}[.)] /
const COMPLETE_MARKER = /❯\u00A0\/|❯\u00A0(?:[^\n]*\s)?@/
// 'complete' (autocomplete) takes precedence — its NBSP marker is the more
// specific of the two; 'choice' is the numbered menu; null = no menu.
// Exported for tests (pane-detect.test.mjs), like collapseBlankRuns.
export function menuKindOf(pane) {
  if (COMPLETE_MARKER.test(pane)) return 'complete'
  if (MENU_MARKER.test(pane)) return 'choice'
  return null
}

// Claude Code stores each session's transcript at
// ~/.claude/projects/<cwd-with-every-non-alnum-as-dash>/<session-id>.jsonl, and
// stamps a per-turn token `usage` block on every `assistant` event. The current
// context-window fill ≈ the latest assistant turn's INPUT side (input +
// cache_read + cache_creation) — that sum is exactly the prompt Claude just
// processed. We derive the project dir from the agent's worktree (its cwd),
// tail-read the newest transcript there, and pull that number. Best-effort: any
// miss (no transcript yet, parse error) → null, and the card just omits the bar.
// NOTE: box-local only — workstation agents run in containers, so their
// transcripts aren't on this filesystem (a separate follow-up).
function readTranscript(s) {
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects', projectKey(s.worktree))
    // A pinned session id (knowledge agents — they all share the vault cwd)
    // names the transcript exactly; dev agents have a per-session worktree, so
    // the newest .jsonl in their project dir is theirs.
    let file = s.claudeSessionId ? path.join(projectsDir, `${s.claudeSessionId}.jsonl`) : null
    if (!file) {
      let newest = null
      for (const f of fs.readdirSync(projectsDir)) {
        if (!f.endsWith('.jsonl')) continue
        const full = path.join(projectsDir, f)
        const m = fs.statSync(full).mtimeMs
        if (!newest || m > newest.m) newest = { full, m }
      }
      if (!newest) return null
      file = newest.full
    }
    // Tail-read: read only the last CONTEXT_TAIL_BYTES so cost stays bounded as
    // transcripts grow into many MiB over a long session.
    const lines = tailLines(file, CONTEXT_TAIL_BYTES)
    if (!lines) return null
    // Most recent assistant turn's input-token sum ≈ the current context fill
    // (shared scanner — the bridge derives it identically from a container
    // transcript). The tail may slice the first line mid-JSON, but it's reached
    // LAST and simply fails to parse, so it's harmless.
    const tokens = scanContextTokens(lines)
    const context = tokens > 0 ? { tokens, window: CONTEXT_WINDOW } : null
    return {
      context,
      sub: collectSubAgents(lines),
      jobs: [collectBackgroundJobs(lines), ...subAgentJobSnaps(file)],
      ship: scanShipMarker(lines),
    }
  } catch {
    return null
  }
}

// Background jobs spawned BY SUB-AGENTS live only in the sub-agent's own
// transcript (<projectsDir>/<session-id>/subagents/agent-<id>.jsonl), not the
// main one. Scan the most recent few; each file's sibling .meta.json carries
// `toolUseId` — the Task/Agent tool_use id the main scan keys its sub-agent
// log on — so the jobs are tagged with their owner and the overview can hang
// them off the right sub-agent node. Best-effort, bounded (newest
// SUBAGENT_SCAN_FILES files, SUBAGENT_TAIL_BYTES tails).
function subAgentJobSnaps(transcriptFile) {
  const snaps = []
  try {
    const dir = path.join(transcriptFile.replace(/\.jsonl$/, ''), 'subagents')
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
      .map((f) => {
        const full = path.join(dir, f)
        return { full, m: fs.statSync(full).mtimeMs }
      })
      .sort((a, b) => b.m - a.m)
      .slice(0, SUBAGENT_SCAN_FILES)
    for (const { full } of files) {
      const lines = tailLines(full, SUBAGENT_TAIL_BYTES)
      if (!lines) continue
      const snap = collectBackgroundJobs(lines)
      if (!snap.seen.length && !snap.status.size) continue
      const meta = readJson(full.replace(/\.jsonl$/, '.meta.json'), null)
      if (meta && meta.toolUseId) for (const j of snap.seen) j.sub = meta.toolUseId
      snaps.push(snap)
    }
  } catch {
    /* no subagents dir (or unreadable) — nothing to attribute */
  }
  return snaps
}

// Short "micro" tags for the sub-agents / background jobs a dev agent fans out —
// the same glance-form labels the overview shows for dev agents (agent-titles.mjs),
// derived from each job's agent-authored description. Discovery is poll-based, so
// one poll can surface a whole fan-out; we compress all of a session's new, still-
// untagged jobs in ONE haiku pass per poll. `microInFlight` guards an id while its
// batch is running so the next poll doesn't re-fire it. Fire-and-forget OFF the
// poll path — the tags land on a later GET. The micro is best-
// effort: a job is shown by its full label until (and if) its tag arrives.
const MICRO_BATCH = 24
const microInFlight = new Set()
// A session's sub-agents/jobs that still lack a micro and aren't already being
// tagged — the input batch for generateMicrosFor.
function pendingMicros(s) {
  const out = []
  for (const e of s.subAgents || [])
    if (e.label && !e.micro && !microInFlight.has(e.id)) out.push({ id: e.id, label: e.label })
  for (const e of s.bgJobs || [])
    if (e.label && !e.micro && !microInFlight.has(e.id)) out.push({ id: e.id, label: e.label })
  return out
}
function generateMicrosFor(s, pending) {
  const batch = pending.slice(0, MICRO_BATCH)
  for (const p of batch) microInFlight.add(p.id)
  generateMicros(batch)
    .then((micros) => {
      let changed = false
      const apply = (arr) => {
        for (const e of arr || []) {
          const m = micros.get(e.id)
          if (m && e.micro !== m) {
            e.micro = m
            changed = true
          }
        }
      }
      apply(s.subAgents)
      apply(s.bgJobs)
      if (changed) persist()
    })
    .catch((e) => console.error('[agent-local] micro tags failed:', e.message))
    .finally(() => {
      for (const p of batch) microInFlight.delete(p.id)
    })
}

// Ship-state markers (ATLAS:READY-TO-SHIP / ATLAS:SHIPPED) are scanned from the
// on-disk transcript by scanShipMarker in subagent-scan.mjs — shared with the
// bridge so workstation dev agents carry the same shipState (see readTranscript).

/* Live stats — a small display the agent publishes ITSELF while it works (see
 * STATS_PREAMBLE in agent-routes.mjs): the agent (typically the long-running
 * background script it launched) rewrites one JSON file with a flat object of
 * its latest numbers. Sampled on the flush timer below, so history accrues even
 * with the dashboard closed:
 *   "label": number        → counter; its sampled history becomes a mini-plot
 *   "label": [done, total] → completion bar
 * The box accumulates each counter's history (one point per file rewrite, so
 * the x-axis is write-indexed, not wall-clock); the writer only ever sends its
 * LATEST values. File gone → display cleared (and the file is per-session, so
 * the whole thing is temporary by construction). Box-local only, like every
 * other transcript-derived card field. Returns whether session state changed. */
function statsFile(id) {
  return path.join(STATE_DIR, 'stats', `${id}.json`)
}
// Fold a raw {label:value} stats object into the card's accumulated items array,
// carrying each counter's `points` history forward from prevItems. Shared by the
// box-local file sampler (sampleLiveStats) and the WORKSTATION accumulator
// (accumulateRemoteStats) so both build the exact same shape the card renders:
//   number        → counter tile { label, value, points } (history → a mini-plot)
//   [done, total] → completion bar { label, value, max }
function accumulateStats(raw, prevItems) {
  const prev = new Map((prevItems || []).map((e) => [e.label, e]))
  const items = []
  for (const [key, v] of Object.entries(raw)) {
    if (items.length >= MAX_STAT_ENTRIES) break
    const label = String(key).replace(/\s+/g, ' ').trim().slice(0, MAX_STAT_LABEL)
    if (!label) continue
    if (typeof v === 'number' && Number.isFinite(v)) {
      const old = prev.get(label)
      // Carry the counter's history forward; a label that changed shape
      // (bar → counter) starts a fresh series.
      let points = old && old.max == null && Array.isArray(old.points) ? old.points.slice() : []
      points.push(v)
      // On overflow, halve by dropping every other point — keeps the whole
      // run's shape (just coarser) instead of sliding the window.
      if (points.length > MAX_STAT_POINTS) points = points.filter((_, i) => i % 2 === 0)
      items.push({ label, value: v, points })
    } else if (
      Array.isArray(v) && v.length === 2 &&
      typeof v[0] === 'number' && Number.isFinite(v[0]) &&
      typeof v[1] === 'number' && Number.isFinite(v[1])
    ) {
      items.push({ label, value: v[0], max: v[1] })
    }
    // Anything else (strings, nested objects) is silently ignored.
  }
  return items
}
function sampleLiveStats(s) {
  let st
  try {
    st = fs.statSync(statsFile(s.id))
  } catch {
    if (s.stats || s.statsMtime != null) {
      delete s.stats
      delete s.statsMtime
      return true
    }
    return false
  }
  if (st.size > MAX_STATS_BYTES || st.mtimeMs === s.statsMtime) return false
  const raw = readJson(statsFile(s.id), null)
  // Unparseable = malformed or caught mid-write — leave statsMtime unset so the
  // next tick retries; the previous good display stays up meanwhile.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  s.statsMtime = st.mtimeMs
  s.stats = accumulateStats(raw, s.stats)
  return true
}

/* Box-side accumulator for WORKSTATION (bridge) agents' live stats. A box-local
 * agent writes its stats file ON the box, so sampleLiveStats above reads + builds
 * the history directly. A workstation agent writes it INSIDE its container, where
 * the bridge cats it each /sessions poll and returns just the raw latest
 * {label:value} (it keeps no per-session history). We mirror sampleLiveStats here,
 * keyed by the remote session id, so workstation counters accrue the same `points`
 * history + mini-plots. Driven from the bridge-session merge (trackRemotePhases in
 * agent-routes.mjs), which runs on BOTH the GET poll and the 3s remote-phase timer
 * — so history accrues even with the dashboard closed, like the box-local sampler.
 * Deduped by content so those two polls don't double-count a point. */
const remoteStats = new Map() // id -> { items, lastRaw }
export function accumulateRemoteStats(id, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    // No stats from the bridge (file absent / unreadable) → clear, mirroring the
    // box-local statSync-miss path.
    remoteStats.delete(id)
    return null
  }
  const key = JSON.stringify(raw)
  const prev = remoteStats.get(id)
  // Unchanged since the last poll → keep the history as-is, don't add a duplicate
  // point (the GET poll and the phase timer both land here within a few seconds).
  if (prev && prev.lastRaw === key) return prev.items
  const items = accumulateStats(raw, prev && prev.items)
  remoteStats.set(id, { items, lastRaw: key })
  return items
}
// Drop a vanished remote session's stats history (called when its phase shadow is
// reaped) so a re-used id can't inherit stale points.
export function dropRemoteStats(id) {
  remoteStats.delete(id)
}

// Sub-agents the dev agent spawned with Claude Code's Task tool (workflows mode):
// collectSubAgents snapshots the tail; mergeSubAgentLog folds snapshots into the
// session's persistent list so finished ones stay listed (struck through in the
// UI) for the agent's lifetime instead of vanishing when they scroll out of the
// tail. Both live in subagent-scan.mjs (shared with the research queue). Box-
// local only (needs the on-disk transcript), like the meter.
function mergeSubAgents(s, snap) {
  return mergeSubAgentLog(s.subAgents || (s.subAgents = []), snap)
}

// Background jobs the dev agent launched with Bash run_in_background (detached
// processes, e.g. a long crawl): same snapshot→persistent-log fold, but with
// STICKY status — a job stays 'running' until the harness's completion
// notification flips it to 'done'/'failed' (see subagent-scan.mjs). One
// snapshot per transcript scanned (the main one + recent sub-agent ones).
// Box-local only, like the rest of the transcript-derived fields.
function mergeBgJobs(s, snaps) {
  let changed = false
  for (const snap of snaps || []) {
    if (mergeBackgroundJobLog(s.bgJobs || (s.bgJobs = []), snap)) changed = true
  }
  return changed
}

// Is this session actively merging right now? — at the FRONT of the train AND in
// the SHIPPING state with its ship prompt already delivered (vs. merely waiting
// its turn). The lifecycle state IS the per-member phase now.
function shipActivelyMerging(s) {
  return !!(s && s.lc && s.lc.state === LC.SHIPPING && s.lc.shipPromptedAt)
}
// Position of a session in the serial ship train (1-based), and whether it's the
// one actively merging right now (the head, mid-ship). null = not enqueued.
function shipTrainPosOf(id) {
  const m = registry.shipTrain.members
  const i = m.findIndex((x) => x.id === id)
  if (i < 0) return null
  return { pos: i + 1, active: i === 0 && shipActivelyMerging(registry.sessions[id]) }
}
// The session currently merging at the front of the train, if any — the flush
// loop skips it so a stray queued prompt can't interleave into an in-flight ship.
function shipHeadActiveId() {
  const h = registry.shipTrain.members[0]
  return h && shipActivelyMerging(registry.sessions[h.id]) ? h.id : null
}
// Is this session the HEAD of the ship train (the only member the driver lets
// START shipping)? This is the serialization: one merge at a time, in order.
function isShipHead(s) {
  const m = registry.shipTrain.members
  return m.length > 0 && m[0].id === s.id
}
// Drop ship-train members whose session is gone or errored (they can't ship) so a
// dead head can't wedge the train or skew the positions behind it. Run at the top
// of each drive (replaces pumpShipTrain's leading-member prune).
function pruneShipTrain() {
  const m = registry.shipTrain.members
  let changed = false
  for (let i = m.length - 1; i >= 0; i--) {
    const s = registry.sessions[m[i].id]
    // Gone, errored, or stuck in a sink (needs_attention/reaped) — none can ship,
    // so drop them rather than let a dead head wedge the train. (The driver removes
    // a member on its own transitions; this catches anything left behind.)
    const inert = s && s.lc && isInert(s.lc.state)
    if (!s || s.status === 'error' || inert) {
      audit({ action: 'ship-drop', id: m[i].id, reason: !s ? 'gone' : s.status === 'error' ? 'error' : 'inert', ok: true })
      m.splice(i, 1)
      changed = true
    }
  }
  return changed
}

function publicView(s, status, lastOutput, menuKind, transcript, appUp, menuChoice) {
  const shipQ = shipTrainPosOf(s.id)
  return {
    id: s.id,
    // 'dev' (worktree + branch on a repo) or 'knowledge' (vault chat, no branch).
    kind: s.kind || 'dev',
    task: s.task,
    repo: s.repo,
    branch: s.branch,
    // Knowledge chats: which vault the chat is grounded in (work/atlas/…). The
    // Knowledge Base + Atlas cards filter the shared session list by this, so it
    // MUST be surfaced or an Atlas chat routes to the wrong card. Absent on dev
    // agents and pre-field knowledge chats (the card treats absent as 'work').
    ...(s.vault ? { vault: s.vault } : {}),
    status,
    lastOutput: lastOutput ?? '',
    menu: !!menuKind,
    menuKind: menuKind || null,
    // Parsed numbered options of a pending choice menu (+ which one the TUI's
    // `❯` sits on), so the chat view can offer them as clickable buttons, plus
    // the prompt text above them so the operator sees WHAT they're answering.
    ...(menuChoice
      ? {
          menuOptions: menuChoice.options,
          menuHighlighted: menuChoice.highlighted,
          ...(menuChoice.question ? { menuQuestion: menuChoice.question } : {}),
        }
      : {}),
    startedAt: s.startedAt,
    // Knowledge chat in its wrap-up turn (✕ pressed): flushing unsaved insights
    // to the vault; the session is reaped when the turn ends. Derived from the
    // lifecycle state (`ingesting`) — see agent-lifecycle.mjs.
    ...(isClosing(s.lc?.state) ? { closing: true } : {}),
    // The persisted lifecycle state (spawned/working/…/reaping/needs_attention),
    // for observability. The card doesn't switch on it (it reads `closing` /
    // `closePhase` / `shipState` / `shipQueue` above), but it surfaces the machine.
    ...(s.lc?.state ? { lifecycle: s.lc.state } : {}),
    // Tmux vanished out from under a still-registered session (box reboot,
    // kill-server) — the card renders this as "lost", not "done".
    ...(s.interrupted ? { interrupted: true } : {}),
    // Spawn-time picks (resolved model ID + effort level). The card shows them
    // as a small label by the context meter. Absent on sessions spawned before
    // the field landed → the label just doesn't render.
    ...(s.model ? { model: s.model } : {}),
    ...(s.effort ? { effort: s.effort } : {}),
    // Spawn-time task work-size (S/M/L) from the title agent — feeds the estimator
    // and shows as a small tag. Absent until classified / on older sessions.
    ...(s.size ? { size: s.size } : {}),
    // Time tracking (agent-timings.mjs): `phase` is run/wait/done; while in a run
    // the card ticks `runStartedAt`→now against the rough `runEstimateMs` and its
    // p25–p75 band (`runEstimateLoMs`/`runEstimateHiMs`); when idle it shows the
    // frozen `lastRunMs`; `endedAt` freezes the "alive" clock.
    ...(s.phase ? { phase: s.phase } : {}),
    ...(s.runStartedAt ? { runStartedAt: s.runStartedAt } : {}),
    ...(s.runEstimateMs != null ? { runEstimateMs: s.runEstimateMs } : {}),
    ...(s.runEstimateLoMs != null ? { runEstimateLoMs: s.runEstimateLoMs } : {}),
    ...(s.runEstimateHiMs != null ? { runEstimateHiMs: s.runEstimateHiMs } : {}),
    ...(s.lastRunMs != null ? { lastRunMs: s.lastRunMs } : {}),
    ...(s.endedAt ? { endedAt: s.endedAt } : {}),
    // Prompts waiting to be delivered when this session next goes idle, in FIFO
    // order (the card shows each as a cancellable chip). Only the text + image
    // count are surfaced; the saved image paths stay server-side.
    ...(Array.isArray(s.queued) && s.queued.length
      ? {
          queued: s.queued.map((q) => ({
            text: q.text || '',
            images: (q.paths || []).length,
            ...(q.kind ? { kind: q.kind } : {}),
            ...(q.summary ? { summary: q.summary } : {}),
          })),
        }
      : {}),
    ...(transcript && transcript.context
      ? { contextTokens: transcript.context.tokens, contextWindow: transcript.context.window }
      : {}),
    ...(s.subAgents && s.subAgents.length
      ? { subAgents: s.subAgents.map((e) => ({ label: e.label, ...(e.micro ? { micro: e.micro } : {}), active: !e.done })) }
      : {}),
    ...(s.bgJobs && s.bgJobs.length
      ? {
          // `sub` (when the job was spawned by a sub-agent) goes out as the
          // owner's INDEX in the subAgents array above — both map over the
          // same logs in order, so the index is stable for the client.
          bgJobs: s.bgJobs.map((e) => {
            const sub = e.sub ? (s.subAgents || []).findIndex((a) => a.id === e.sub) : -1
            return { label: e.label, ...(e.micro ? { micro: e.micro } : {}), status: e.status, ...(sub >= 0 ? { sub } : {}) }
          }),
        }
      : {}),
    // Live stats the agent publishes itself (sampleLiveStats above): counters
    // carry their accumulated history for the card's mini-plot, [done,total]
    // entries carry `max` for a completion bar.
    ...(s.stats && s.stats.length ? { stats: s.stats } : {}),
    // Agent-signaled ship state (ATLAS:READY-TO-SHIP / ATLAS:SHIPPED markers):
    // the card highlights the Ship button on 'ready' and swaps it for a check
    // on 'shipped'; `shipInfo` carries the SHIPPED detail (PR number + SHA).
    ...(s.shipState ? { shipState: s.shipState, ...(s.shipInfo ? { shipInfo: s.shipInfo } : {}) } : {}),
    // Position in the serial ship train (if enqueued): `pos` 1-based, `active`
    // while it's the one currently merging. The card shows "#N" / "shipping…".
    ...(shipQ ? { shipQueue: shipQ } : {}),
    // Live-app slot: where the dashboard embeds this agent's app in full-screen
    // (`appPath`), the loopback port it must bind (`appPort` — so the card can
    // tell the operator where to serve when the pane is empty), and whether
    // something is currently serving it (`appUp` — a TCP probe; the card shows
    // the split pane only when up). Dev agents only — a knowledge chat (repo =
    // vault) has no app slot.
    ...(s.kind !== 'knowledge'
      ? { appPath: `/${appBasePath(s.repo, s.id)}/`, appPort: APP_PORT, ...(appUp != null ? { appUp } : {}) }
      : {}),
    // Paired Atlas worker (box dev agents): the card shows a 📚 chip and treats
    // the ✕ as a GRACEFUL close (recap → worker ingest). `closePhase` is
    // 'recap' | 'ingest' while wrapping up. The worker session itself is hidden
    // from the top-level list (it surfaces only as this chip on its dev agent).
    ...(s.atlasWorker ? { atlasWorker: true } : {}),
    ...(s.lc?.closePhase ? { closePhase: s.lc.closePhase } : {}),
  }
}

export async function listSessions() {
  const out = []
  let changed = false
  // One probe of the shared box-local app slot per poll — its liveness is the
  // same for every dev session (single port), so the card knows whether to offer
  // the side-by-side app pane.
  const appUp = await probeTcp(APP_PORT)
  for (const s of Object.values(registry.sessions)) {
    // Paired Atlas workers (briefing/ingest attached to a BOX dev agent) surface on
    // that dev agent's card (the 📚 chip / closePhase), not as their own row. But a
    // STANDALONE worker — the ephemeral ingest spun up when a WORKSTATION agent
    // closes — has no box dev card to hang off, so show it in the agents overview.
    if (s.kind === 'atlas' && !s.standalone) continue
    if (s.status === 'error') {
      out.push(publicView(s, 'error', s.error || 'spawn failed'))
      continue
    }
    const alive = await sessionAlive(s)
    // One pane capture serves both the status (is it still working?) and the tail.
    const pane = alive ? await captureTail(s, TAIL_LINES) : ''
    let status = alive ? (isBusy(pane) ? 'running' : 'idle') : 'done'
    // A reconciler-parked orphan stays 'dormant' (operator-revivable) while its
    // tmux is down — don't relabel it 'lost'/'done' on the poll. A revive brings
    // the tmux back, so `alive` flips it to running/idle here as normal.
    if (!alive && s.status === 'dormant') status = 'dormant'
    // A session still in the registry whose tmux is gone was torn down out from
    // under it (a box reboot, a `tmux kill-server`) — kill/cleanup delete the
    // entry instead, and a graceful close (lifecycle `ingesting`) reaps it.
    // Flag the rest so the card shows "lost", not an indistinguishable "done".
    if (status === 'done' && !s.interrupted && !isClosing(s.lc?.state)) {
      s.interrupted = true
      changed = true
    }
    if (s.status !== status) {
      s.status = status
      changed = true
    }
    // Feed the observed status into the phase tracker (live run/wait timer +
    // history). Terminal ('done') logs the agent's lifetime record; running/idle
    // drive the run/wait alternation. Idempotent, so it's safe that the 3s timer
    // (samplePhases) does the same off the poll path.
    const phaseNow = Date.now()
    if (status === 'dormant') {
      // Parked: no run/wait clock, no lifetime record — it resumes on revive.
    } else if (status === 'done') {
      if (recordLifetime(s, phaseNow)) changed = true
    } else if (s.lifetimeLogged || s.interrupted || s.endedAt || s.phase === 'done') {
      // Stamped terminal (its tmux had vanished → recordLifetime ran / it was
      // flagged "lost") but observed ALIVE again — recovered by resuming its Claude
      // session in a fresh tmux, or the box came back. Undo the terminal stamp so
      // the card reads as a live agent again instead of a frozen "lost"; the next
      // poll's trackPhase then drives the run/wait clock normally.
      if (revivePhase(s, status, phaseNow)) changed = true
    } else if (trackPhase(s, status, phaseNow)) changed = true
    const tail = alive ? lastLine(pane) : s.lastSeen || ''
    if (alive && tail && tail !== s.lastSeen) {
      s.lastSeen = tail
      changed = true
    }
    const menuKind = status === 'idle' ? menuKindOf(pane) : null
    // A choice menu's numbered options, parsed from the same bottom-window pane
    // (the messenger's tested parser) — the chat view renders them as buttons.
    const menuChoice = menuKind === 'choice' ? parseChoiceMenu(pane) : null
    const transcript = readTranscript(s)
    if (transcript && mergeSubAgents(s, transcript.sub)) changed = true
    if (transcript && mergeBgJobs(s, transcript.jobs)) changed = true
    // Derive the short glance-form tags for any newly-seen sub-agents/jobs (one
    // batched haiku pass, fire-and-forget — see generateMicrosFor).
    const pendMicro = pendingMicros(s)
    if (pendMicro.length) generateMicrosFor(s, pendMicro)
    // Sticky: keep the last marker seen even after it scrolls out of the
    // transcript tail; only a newer marker replaces it.
    const ship = transcript && transcript.ship
    if (ship && (s.shipState !== ship.state || (s.shipInfo || '') !== ship.info)) {
      s.shipState = ship.state
      s.shipInfo = ship.info
      changed = true
    }
    out.push(publicView(s, status, tail || s.lastSeen || '', menuKind, transcript, appUp, menuChoice))
  }
  if (changed) persist()
  out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
  return out
}

// Claude Code gates the FIRST launch in a folder behind a "trust this folder?"
// dialog that --dangerously-skip-permissions does NOT bypass — an interactive tmux
// worker just hangs on it forever (never running its task, nor its close-time
// vault ingest). Trust is keyed on the git repo ROOT and inherited by worktrees.
// A box-local repo or the vault may never have been accepted interactively, so
// pre-accept its root here — idempotently — before any launch in it. Best-effort
// + atomic (temp then rename): if the config is unreadable/locked we just fall
// back to the old prompt.
function ensureRepoTrusted(repoRoot) {
  try {
    const cfgFile = path.join(os.homedir(), '.claude.json')
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    if (!cfg.projects) cfg.projects = {}
    if (!cfg.projects[repoRoot]) cfg.projects[repoRoot] = {}
    if (cfg.projects[repoRoot].hasTrustDialogAccepted === true) return // already trusted — never rewrite
    cfg.projects[repoRoot].hasTrustDialogAccepted = true
    const tmp = `${cfgFile}.atlas-kit-trust-tmp`
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2))
    fs.renameSync(tmp, cfgFile)
  } catch {
    /* config missing/locked/corrupt → claude shows the dialog as before */
  }
}

// ── Concurrency cap + crash self-heal ──────────────────────────────────────
// Live box-local agents right now (one tmux listing). No server / empty → 0.
async function liveAgentCount() {
  const r = await run(['tmux', 'ls', '-F', '#{session_name}'])
  return (r.stdout || '').split('\n').filter((n) => n.startsWith('agentbox-')).length
}
// Spawn guard: refuse to launch when the box is at the count ceiling OR low on
// RAM, so a burst can't OOM it. The count (MAX_LIVE) is a generous safety ceiling;
// free RAM (memHeadroom — same FLOOR + per-agent gate the revive path uses) is the
// real brake, so spawns self-throttle to actual pressure rather than a guessed N.
async function atCapacity() {
  const live = await liveAgentCount()
  if (live >= MAX_LIVE)
    return {
      status: 503,
      ok: false,
      error: `box at agent capacity (${live}/${MAX_LIVE} live) — close one or raise AGENT_LOCAL_MAX_CONCURRENT`,
    }
  const mem = memHeadroom()
  if (!mem.ok)
    return {
      status: 503,
      ok: false,
      error: `box low on memory (${mem.avail} MB free) — close an agent first, then spawn`,
    }
  return null
}
// Free RAM right now, in MB (MemAvailable — accounts for reclaimable cache). Falls
// back to os.freemem() off Linux (dev only); Infinity if nothing is readable, so a
// missing /proc never blocks a revive.
function availMemMb() {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m)
    if (m) return Math.round(Number(m[1]) / 1024)
  } catch {
    /* no /proc — fall through to the os fallback */
  }
  try {
    return Math.round(os.freemem() / 1048576)
  } catch {
    return Infinity
  }
}
// Room to launch one more agent? Returns {avail, ok} — ok once free RAM clears the
// floor + one-agent headroom (REVIVE_MEM_* above).
function memHeadroom() {
  const avail = availMemMb()
  return { avail, ok: avail >= REVIVE_MEM_FLOOR_MB + REVIVE_MEM_PER_AGENT_MB }
}
// The Claude session id to `--resume`: the pinned one (knowledge/atlas) or the
// newest transcript in this worktree's project dir (dev agents don't pin one —
// each has its own worktree, so newest is unambiguous). null if none readable.
function resumeId(s) {
  if (s.claudeSessionId) return s.claudeSessionId
  try {
    const dir = path.join(os.homedir(), '.claude', 'projects', projectKey(s.worktree))
    let newest = null
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      const m = fs.statSync(path.join(dir, f)).mtimeMs
      if (!newest || m > newest.m) newest = { id: f.replace(/\.jsonl$/, ''), m }
    }
    return newest ? newest.id : null
  } catch {
    return null
  }
}
// A large resumed session opens Claude Code's "Resume from summary?" choice menu
// (option 1 = recommended, already highlighted). Best-effort: if it's up a few
// seconds after launch, confirm it; a harmless empty submit otherwise.
function scheduleMenuClear(tmux) {
  setTimeout(async () => {
    try {
      const pane = (await run(['tmux', 'capture-pane', '-t', tmux, '-p', '-S', '-6'])).stdout || ''
      if (/Resume from summary|Resume full session|Enter to confirm/.test(pane))
        await run(['tmux', 'send-keys', '-t', tmux, 'Enter'])
    } catch {
      /* session gone / tmux hiccup — nothing to clear */
    }
  }, RECONCILE_MENU_MS)
}
// Park an orphan as 'dormant': its tmux died (a tmux-server death — reboot/OOM,
// or `tmux kill-server`) but its worktree + Claude transcript are intact, so it's
// revivable. We DON'T auto-revive (a burst would OOM the RAM-bound box) — the card
// shows it 'dormant' with a Revive button and the operator brings back the ones
// they want (one at a time, or the memory-gated "Revive all").
function markDormant(s) {
  s.status = 'dormant'
  // Clear the "lost"/terminal stamps the poll may have set, so the card reads
  // 'dormant' (revivable), not 'lost' (gone) — and so a later revive opens a clean
  // run/wait clock instead of "undoing" a terminal stamp.
  delete s.interrupted
  delete s.lifetimeLogged
  delete s.endedAt
  delete s.phasePending
  delete s.phase
  delete s.runStartedAt
}
// Interpret a `tmux ls` result into the set of live session names — or null when
// the result is INCONCLUSIVE and reconcile must NOT act on it. A non-zero exit is
// ambiguous: tmux's "error connecting"/"no server running" means the server is
// genuinely gone (every agent really is orphaned → empty set, park them), but ANY
// OTHER failure (an exec timeout, a fork failure under memory pressure) returns the
// SAME empty output — and parking the whole fleet on a transient hiccup is the exact
// false-orphan to avoid. So only an explicit "server gone" failure is authoritative;
// everything else returns null and the caller skips the pass. Pure + exported so the
// three cases are unit-tested (test/agent-revive.test.mjs) without a live tmux.
export function liveSessionsFromLs(r) {
  if (r.ok) return new Set((r.stdout || '').split('\n').filter(Boolean))
  if (/error connecting|no server running/i.test(r.stderr || '')) return new Set()
  return null // inconclusive — a hiccup, not a dead server: don't risk parking
}
// Boot self-heal: PARK (don't revive) sessions a tmux-server death orphaned —
// present in BOOT_ALIVE (alive when we loaded state.json) but with no live tmux.
// They go 'dormant'; the operator revives them from the dashboard. Kill-switch:
// AGENT_LOCAL_RECONCILE=0/off. NOTE a `serve.sh restart` is session-scoped, so
// agent tmux SURVIVES it — this only finds orphans after a true server death.
async function reconcileOrphans() {
  if (!RECONCILE) return
  const live = liveSessionsFromLs(await run(['tmux', 'ls', '-F', '#{session_name}']))
  // tmux ls failed for some reason OTHER than a dead server — inconclusive. Bail
  // rather than mass-park live agents on a transient glitch (Express now restarts
  // on every deploy, so this path runs each time and a false-orphan is costly).
  if (!live) return
  const candidates = Object.values(registry.sessions).filter((s) => {
    if (!BOOT_ALIVE.has(s.id)) return false // wasn't alive at load — leave it
    if (live.has(s.tmux)) return false // survived a scoped restart — still running
    if (isClosing(s.lc?.state) || s.status === 'error') return false
    // shipping / ingesting / reaping / needs_attention are owned by the lifecycle
    // driver (it advances or flags them on its own) — don't also park them dormant.
    if (s.lc && s.lc.state !== LC.SPAWNED && !QUIESCENT.has(s.lc.state)) return false
    if (!s.worktree || !fs.existsSync(s.worktree)) return false
    return !!resumeId(s) // no resumable transcript → can't revive → don't park it
  })
  if (!candidates.length) return
  for (const s of candidates) {
    markDormant(s)
    audit({ action: 'dormant', id: s.id, repo: s.repo, kind: s.kind || 'dev', ok: true })
  }
  persist()
}
// Relaunch a session's Claude session in a fresh tmux under its expected name —
// the shared core of revive()/reviveAll() (the launch the old auto-reconciler ran):
// `claude --resume` in the worktree, repo pre-trusted, the resume menu auto-
// confirmed. Clears the terminal stamps so the next poll renders it live. Returns
// the run() result ({ ok, stderr }).
async function launchResume(s) {
  const sid = resumeId(s)
  if (!sid) return { ok: false, stderr: 'no resumable Claude session found' }
  // The Atlas orchestrator (vault:'atlas' chat) must resume WITH its agent-control
  // MCP config or it loses its spawn/prompt/kill steering tools; all else resumes plain.
  const tmpl = s.vault === 'atlas' ? ATLAS_CONTROL_RESUME_CMD : RESUME_CMD
  const launch = tmpl
    .replace('{atlasSession}', shquote(s.id)) // no-op token on the plain template
    .replace('{model}', shquote(s.model || DEFAULT_MODEL))
    .replace('{effort}', shquote(s.effort || DEFAULT_EFFORT))
    .replace('{sid}', shquote(sid))
  ensureRepoTrusted(s.worktree)
  const ns = await run(['tmux', 'new-session', '-d', '-s', s.tmux, '-c', s.worktree, 'sh', '-lc', launch])
  if (!ns.ok) return ns
  s.status = 'running'
  delete s.interrupted
  delete s.lifetimeLogged
  delete s.endedAt
  delete s.phasePending
  s.reconciledAt = nowIso()
  scheduleMenuClear(s.tmux)
  return ns
}
// Operator revive of one dormant box-local agent (the card's Revive button).
// Idempotent (already-alive → ok). Memory-gated so a click can't OOM the box; also
// revives the paired Atlas worker if IT is dormant, so the pair comes back together
// (mirrors how kill/cleanup reap the worker alongside).
export async function revive({ id }) {
  const s = registry.sessions[id]
  if (!s) return { status: 404, ok: false, error: 'no such session' }
  if (await sessionAlive(s)) return { status: 200, ok: true, already: true }
  if (!s.worktree || !fs.existsSync(s.worktree)) return { status: 409, ok: false, error: 'worktree is gone — nothing to resume' }
  const mem = memHeadroom()
  if (!mem.ok) return { status: 503, ok: false, error: `box low on memory (${mem.avail} MB free) — close an agent first, then revive` }
  const r = await launchResume(s)
  if (!r.ok) return { status: 500, ok: false, error: `revive failed: ${(r.stderr || '').slice(0, 200)}` }
  audit({ action: 'revive', id: s.id, repo: s.repo, kind: s.kind || 'dev', ok: true })
  // Bring the paired Atlas worker back too if it was parked (best-effort — a memory
  // shortfall just leaves it dormant for a later revive).
  const w = s.atlasWorker && registry.sessions[s.atlasWorker]
  if (w && w.status === 'dormant' && !(await sessionAlive(w)) && memHeadroom().ok) {
    if ((await launchResume(w)).ok) audit({ action: 'revive', id: w.id, repo: w.repo, kind: 'atlas', ok: true })
  }
  persist()
  return { status: 200, ok: true }
}
// Memory-aware bulk revive (the "Revive all" button): bring back every dormant
// box-local agent, newest first, staggered — but STOP before the box runs low on
// RAM, so it revives as many as safely fit instead of a blind count. Reports how
// many it revived and how many it held back.
export async function reviveAll() {
  const dormant = Object.values(registry.sessions)
    .filter((s) => s.status === 'dormant' && s.worktree && fs.existsSync(s.worktree) && resumeId(s))
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
  let revived = 0
  let held = 0
  for (let i = 0; i < dormant.length; i++) {
    const s = dormant[i]
    if (await sessionAlive(s)) continue // already back (e.g. revived as a pair)
    if (!memHeadroom().ok) {
      held = dormant.length - i
      break
    }
    if ((await launchResume(s)).ok) {
      revived++
      audit({ action: 'revive', id: s.id, repo: s.repo, kind: s.kind || 'dev', ok: true })
      await sleep(REVIVE_STAGGER_MS)
    }
  }
  if (revived) persist()
  if (held) audit({ action: 'revive-held', revived, held, floorMb: REVIVE_MEM_FLOOR_MB, availMb: availMemMb(), ok: true })
  return { status: 200, ok: true, revived, held }
}
// ───────────────────────────────────────────────────────────────────────────

export async function spawn({ task, repo, preamble, model, effort, context, images }) {
  if (!task || typeof task !== 'string') return { status: 400, ok: false, error: 'task required' }
  const repos = loadRepos()
  const target = repos[repo]
  if (!target) return { status: 400, ok: false, error: `unknown box repo "${repo}"` }
  const capErr = await atCapacity()
  if (capErr) return capErr

  const base = slugify(task)
  if (!base) return { status: 400, ok: false, error: 'task has no usable slug' }
  let id = base
  for (let n = 2; registry.sessions[id]; n++) id = `${base}-${n}`

  // Save any attached files to this session's upload dir BEFORE creating the
  // worktree (a bad attachment fails fast, with no orphan worktree); their paths
  // fold into the opening task below so the agent can Read them on its first turn.
  let imagePaths = []
  if (Array.isArray(images) && images.length) {
    try {
      imagePaths = saveImages(id, images)
    } catch (e) {
      return { status: 400, ok: false, error: e.message }
    }
  }

  const repoPath = target.path || WORKSPACE
  const branch = `agent/${id}`
  const tmux = `agentbox-${id}`
  // Worktrees default OUTSIDE the repo (keeps the prod /workspace checkout clean).
  const worktreeBase = target.worktreeBase || path.join(STATE_DIR, 'worktrees', repo)
  const worktree = path.join(worktreeBase, id)

  const session = {
    id, task, repo, branch, path: repoPath, worktree, tmux,
    model: model || DEFAULT_MODEL, effort: effort || DEFAULT_EFFORT,
    status: 'running', startedAt: nowIso(), lc: initLifecycle(LC.SPAWNED),
  }

  await run(['mkdir', '-p', worktreeBase])
  const wt = await run(['git', '-C', repoPath, 'worktree', 'add', '-b', branch, worktree])
  if (!wt.ok) {
    session.status = 'error'
    session.error = (wt.stderr || 'git worktree add failed').slice(0, 500)
    registry.sessions[id] = session
    persist()
    audit({ action: 'spawn', id, repo, ok: false, error: session.error })
    return { status: 502, ok: false, error: session.error }
  }

  // The slug/branch derive from `task` only; an optional `preamble` (standing
  // instructions injected by the proxy, e.g. the reconcile protocol) is appended
  // to the prompt the agent actually receives — so branch names stay clean.
  // `{statsFile}` in the preamble becomes this session's live-stats path (only
  // the executor knows the id); the dir is pre-created so a bare `>` redirect
  // from the agent's first background script just works.
  fs.mkdirSync(path.join(STATE_DIR, 'stats'), { recursive: true })
  // `context` (when present) is the pre-formed `## Relevant Atlas context` block
  // from the spawn route's paired-worker briefing — injected between the standing
  // preamble and the task so the agent starts WITH it.
  // Attached-file paths fold into the task text (a single-line tail) so the agent
  // reads them on its first turn — same mechanism as a follow-up prompt's images.
  const taskBody = withImages(task, imagePaths)
  const prompt = preamble
    ? `${injectApp(preamble.replaceAll('{statsFile}', statsFile(id)), repo, id)}${context ? `\n\n${context}` : ''}\n\n---\n# Your task\n${taskBody}`
    : taskBody
  const launch = LAUNCH_CMD
    .replace('{model}', shquote(model || DEFAULT_MODEL))
    .replace('{effort}', shquote(effort || DEFAULT_EFFORT))
    .replace('{task}', shquote(prompt))
  ensureRepoTrusted(repoPath) // so the worktree launch skips Claude Code's trust dialog
  const ns = await run([
    'tmux', 'new-session', '-d', '-s', tmux, '-c', worktree, 'sh', '-lc', launch,
  ])
  if (!ns.ok) {
    session.status = 'error'
    session.error = (ns.stderr || 'tmux new-session failed').slice(0, 500)
    registry.sessions[id] = session
    persist()
    audit({ action: 'spawn', id, repo, ok: false, error: session.error })
    return { status: 502, ok: false, error: session.error }
  }

  registry.sessions[id] = session
  persist()
  audit({ action: 'spawn', id, repo, branch, model: model || DEFAULT_MODEL, effort: effort || DEFAULT_EFFORT, images: imagePaths.length, ok: true })
  return { status: 200, ok: true, id }
}

/* Knowledge agent: an interactive vault chat (a vault chat).
 * Same tmux + registry contract as a dev agent, but it lives IN the work vault
 * (cwd = vault root, so the vault's own CLAUDE.md conventions auto-load) with
 * no git worktree and no branch — the vault is not branch-isolated; the
 * preamble's add-and-link + pull-rebase-then-commit rules are the boundary.
 * Gated on the same opt-in as the rest of box-local execution (the repo
 * allowlist file): no allowlist → no execution on this box, of either kind. */
export async function spawnKnowledge({ question, preamble, model, effort, vault }) {
  if (!question || typeof question !== 'string') return { status: 400, ok: false, error: 'question required' }
  if (!localRepoKeys().length) return { status: 503, ok: false, error: 'box-local executor disabled' }
  // `vault` (a key) is optional → the default vault, so a plain Knowledge Base
  // chat is unchanged; the Atlas tab passes vault:'atlas' to chat over the Atlas.
  const vlt = resolveVault(vault)
  if (!vlt) return { status: vault ? 404 : 503, ok: false, error: vault ? `unknown vault "${vault}"` : 'no vault configured' }
  const capErr = await atCapacity()
  if (capErr) return capErr

  const slug = slugify(question)
  if (!slug) return { status: 400, ok: false, error: 'question has no usable slug' }
  // Scope the id by vault so an Atlas chat reads as `kb-atlas-…` and can't collide
  // with a work-vault `kb-…` of the same slug.
  const base = vlt.key === defaultVaultKey() ? `kb-${slug}` : `kb-${vlt.key}-${slug}`
  let id = base
  for (let n = 2; registry.sessions[id]; n++) id = `${base}-${n}`

  const tmux = `agentbox-${id}`
  const claudeSessionId = randomUUID()
  const session = {
    id, kind: 'knowledge', task: question, repo: 'vault', vault: vlt.key,
    path: vlt.path, worktree: vlt.path, tmux, claudeSessionId,
    model: model || DEFAULT_MODEL, effort: effort || DEFAULT_EFFORT,
    status: 'running', startedAt: nowIso(), lc: initLifecycle(LC.SPAWNED),
  }

  const prompt = preamble ? `${preamble}\n\n---\n# Operator question\n${question}` : question
  const launch = (vlt.key === 'atlas' ? ATLAS_CONTROL_LAUNCH_CMD : KNOWLEDGE_LAUNCH_CMD)
    .replace('{atlasSession}', shquote(id)) // no-op for the non-atlas template
    .replace('{model}', shquote(model || DEFAULT_MODEL))
    .replace('{effort}', shquote(effort || DEFAULT_EFFORT))
    .replace('{sid}', shquote(claudeSessionId))
    .replace('{task}', shquote(prompt))
  ensureRepoTrusted(vlt.path) // so the launch skips Claude Code's trust dialog
  const ns = await run([
    'tmux', 'new-session', '-d', '-s', tmux, '-c', vlt.path, 'sh', '-lc', launch,
  ])
  if (!ns.ok) {
    session.status = 'error'
    session.error = (ns.stderr || 'tmux new-session failed').slice(0, 500)
    registry.sessions[id] = session
    persist()
    audit({ action: 'spawn', kind: 'knowledge', id, vault: vlt.key, ok: false, error: session.error })
    return { status: 502, ok: false, error: session.error }
  }

  registry.sessions[id] = session
  persist()
  audit({ action: 'spawn', kind: 'knowledge', id, vault: vlt.key, model: model || DEFAULT_MODEL, effort: effort || DEFAULT_EFFORT, ok: true })
  return { status: 200, ok: true, id }
}

/* Atlas worker: a knowledge worker PAIRED to a dev agent (see
 * the paired-worker design). Like spawnKnowledge it's a vault-
 * rooted interactive session with a pinned --session-id, BUT it works in a git
 * WORKTREE of the Atlas on its own branch `atlas/<slug>`, so its writes stay
 * isolated until the Atlas ship queue merges them. Spawned BEFORE the dev agent
 * (so its briefing can go into the dev agent's first prompt), then cross-linked
 * via pairAtlasWorker. Not operator-chatted — its first turn IS the brief
 * request; the dashboard later hands it the dev agent's recap at cleanup. The
 * Atlas path comes from the vault registry (`atlas`); a soft failure (atlas not
 * configured / box-local off) means the dev agent simply runs UNPAIRED. */
export async function spawnAtlasWorker({ task, preamble, firstTurn }) {
  if (!task || typeof task !== 'string') return { status: 400, ok: false, error: 'task required' }
  if (!localRepoKeys().length) return { status: 503, ok: false, error: 'box-local executor disabled' }
  const atlas = resolveVault('atlas')
  if (!atlas) return { status: 503, ok: false, error: 'atlas vault not configured' }

  const slug = slugify(task)
  if (!slug) return { status: 400, ok: false, error: 'task has no usable slug' }
  let id = `atlas-${slug}`
  for (let n = 2; registry.sessions[id]; n++) id = `atlas-${slug}-${n}`

  const branch = `atlas/${id.replace(/^atlas-/, '')}`
  const tmux = `agentbox-${id}`
  const worktreeBase = path.join(STATE_DIR, 'worktrees', 'atlas')
  const worktree = path.join(worktreeBase, id)
  const claudeSessionId = randomUUID()
  const session = {
    id, kind: 'atlas', task,
    repo: 'atlas', path: atlas.path, branch, worktree, tmux, claudeSessionId,
    model: DEFAULT_MODEL, effort: DEFAULT_EFFORT,
    // Paired/standalone Atlas workers are NOT driven by the main lifecycle driver
    // (it skips kind:'atlas'); their teardown is owned by their dev agent's close
    // flow / ingestToAtlas. An lc is still stamped for uniformity + migration.
    status: 'running', startedAt: nowIso(), lc: initLifecycle(LC.WORKING),
  }

  await run(['mkdir', '-p', worktreeBase])
  const wt = await run(['git', '-C', atlas.path, 'worktree', 'add', '-b', branch, worktree])
  if (!wt.ok) {
    audit({ action: 'spawn', kind: 'atlas', id, ok: false, error: (wt.stderr || '').slice(0, 500) })
    return { status: 502, ok: false, error: (wt.stderr || 'git worktree add failed').slice(0, 500) }
  }

  // The first turn IS the brief request, so the worker starts traversing
  // immediately; briefWorker (the caller) waits for it to finish and reads the
  // reply. Standing BRIEF/INGEST/write rules live in the preamble.
  // The worker's first turn: a BRIEF request by default; the remote-ingest path
  // passes its own `firstTurn` (the INGEST prompt) instead. The preamble (standing
  // BRIEF/INGEST/write rules) is prepended either way.
  const body = firstTurn
    || `# Brief the dev agent\nFollow your BRIEF instructions for the task below — traverse the Atlas and reply with a concise, prescriptive briefing (what's relevant + any ⚠️ cautions). Write nothing.\n\nTask: ${task}`
  const head = preamble ? `${preamble}\n\n---\n${body}` : (firstTurn || task)
  const launch = KNOWLEDGE_LAUNCH_CMD
    .replace('{model}', shquote(DEFAULT_MODEL))
    .replace('{effort}', shquote(DEFAULT_EFFORT))
    .replace('{sid}', shquote(claudeSessionId))
    .replace('{task}', shquote(head))
  ensureRepoTrusted(atlas.path) // so the Atlas worktree launch skips Claude Code's trust dialog
  const ns = await run(['tmux', 'new-session', '-d', '-s', tmux, '-c', worktree, 'sh', '-lc', launch])
  if (!ns.ok) {
    // Undo the worktree we just created so a failed launch leaves no orphan.
    await run(['git', '-C', atlas.path, 'worktree', 'remove', worktree, '--force'])
    await run(['git', '-C', atlas.path, 'branch', '-D', branch])
    audit({ action: 'spawn', kind: 'atlas', id, ok: false, error: (ns.stderr || '').slice(0, 500) })
    return { status: 502, ok: false, error: (ns.stderr || 'tmux new-session failed').slice(0, 500) }
  }

  registry.sessions[id] = session
  persist()
  audit({ action: 'spawn', kind: 'atlas', id, branch, ok: true })
  return { status: 200, ok: true, id }
}

// The most recent assistant message's text (its text blocks, joined) from a
// session's transcript — used to capture an Atlas worker's briefing reply. Same
// pinned-session file resolution as readTranscript; '' when nothing readable.
function lastAssistantText(s) {
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects', projectKey(s.worktree))
    // A pinned session id (atlas workers) names the file exactly; a dev agent has
    // a per-session worktree, so the newest .jsonl in its project dir is its turn.
    let file = s.claudeSessionId ? path.join(projectsDir, `${s.claudeSessionId}.jsonl`) : null
    if (!file) {
      let newest = null
      for (const f of fs.readdirSync(projectsDir)) {
        if (!f.endsWith('.jsonl')) continue
        const full = path.join(projectsDir, f)
        const m = fs.statSync(full).mtimeMs
        if (!newest || m > newest.m) newest = { full, m }
      }
      if (!newest) return ''
      file = newest.full
    }
    if (!fs.existsSync(file)) return ''
    const lines = tailLines(file, CONTEXT_TAIL_BYTES)
    if (!lines) return ''
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
      const text = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim()
      if (text) return text
    }
    return ''
  } catch {
    return ''
  }
}

// Block until a freshly-spawned Atlas worker finishes its first (brief) turn,
// then return its reply. Polls the pane for the busy→idle edge (with a start
// grace for turns that finish faster than sampling) and reads the briefing from
// the transcript. Bounded: { ok:false, timedOut:true } lets the caller launch
// the dev agent unbriefed. NOTE: this BLOCKS the spawn request up to
// ATLAS_BRIEF_TIMEOUT_MS — the deliberate cost of baking the briefing into the
// dev agent's first prompt (deferred-launch is the future UX optimization).
export async function briefWorker({ id, timeoutMs }) {
  const s = registry.sessions[id]
  if (!s) return { ok: false, error: 'no such worker' }
  const started = Date.now()
  const deadline = started + (Number(timeoutMs) || ATLAS_BRIEF_TIMEOUT_MS)
  let sawBusy = false
  while (Date.now() < deadline) {
    await sleep(ATLAS_BRIEF_POLL_MS)
    if (!(await sessionAlive(s))) return { ok: false, error: 'worker exited' }
    const pane = await captureTail(s, TAIL_LINES)
    if (isBusy(pane)) {
      sawBusy = true
      continue
    }
    // Idle: accept the briefing once we've seen the turn run, or after a short
    // start grace (it may have finished between polls before we caught it busy).
    if (sawBusy || Date.now() - started > ATLAS_BRIEF_GRACE_MS) {
      const text = lastAssistantText(s)
      if (text) {
        audit({ action: 'atlas-brief', id, len: text.length, ok: true })
        return { ok: true, text }
      }
    }
  }
  audit({ action: 'atlas-brief', id, ok: false, timedOut: true })
  return { ok: false, timedOut: true }
}

// Cross-link a dev agent and its Atlas worker so kill/cleanup can find the worker
// and (slice 2) route the recap through it.
export function pairAtlasWorker({ devId, workerId }) {
  const dev = registry.sessions[devId]
  const worker = registry.sessions[workerId]
  if (dev) dev.atlasWorker = workerId
  if (worker) worker.pairedDev = devId
  persist()
  return { ok: true }
}

// Shared front half of prompt/interrupt/queue: resolve the session, validate the
// text/image payload, persist any attachments, and build the single-line payload.
// Returns { err } on any rejection, or { s, payload, text, paths } on success.
async function prepare(id, text, images) {
  const s = registry.sessions[id]
  if (!s) return { err: { status: 404, ok: false, error: 'no such session' } }
  const imgs = Array.isArray(images) ? images : []
  const hasText = typeof text === 'string' && text.length > 0
  if (!hasText && !imgs.length) return { err: { status: 400, ok: false, error: 'text or images required' } }
  if (hasText && text.length > 8000) return { err: { status: 400, ok: false, error: 'text too long' } }
  if (imgs.length > MAX_IMAGES) return { err: { status: 400, ok: false, error: `too many files (max ${MAX_IMAGES})` } }
  if (!(await sessionAlive(s))) return { err: { status: 409, ok: false, error: 'session not running' } }
  let paths
  try {
    paths = imgs.length ? saveImages(id, imgs) : []
  } catch (e) {
    return { err: { status: 400, ok: false, error: e.message } }
  }
  return { s, payload: withImages(hasText ? text : '', paths), text: hasText ? text : '', paths }
}

// Type a single-line payload into the session and submit it (Enter).
async function deliver(s, payload) {
  const t = await run(['tmux', 'send-keys', '-t', s.tmux, '-l', payload])
  if (!t.ok) return { ok: false, error: t.stderr.slice(0, 500) || 'send-keys failed' }
  await run(['tmux', 'send-keys', '-t', s.tmux, 'Enter'])
  return { ok: true }
}

// Remember that an Atlas orchestrator — not the operator — injected this prompt.
// It can't be marked in the transcript itself (it lands as an ordinary tmux-stdin
// user turn), so we keep a small per-session set of steered-prompt fingerprints
// and match them back when reconstructing history (agent-history.mjs tagSteered),
// which colors those bubbles apart in the chat view. Capped + persisted so the
// tagging survives a restart, like the rest of the session record.
const STEER_KEYS_MAX = 60
function recordSteer(s, text, steeredBy) {
  if (!steeredBy || typeof text !== 'string' || !text.trim()) return
  const key = steerKey(text)
  if (!Array.isArray(s.steered)) s.steered = []
  if (s.steered.includes(key)) return
  s.steered.push(key)
  if (s.steered.length > STEER_KEYS_MAX) s.steered = s.steered.slice(-STEER_KEYS_MAX)
}

export async function prompt({ id, text, images, force, steeredBy }) {
  const p = await prepare(id, text, images)
  if (p.err) return p.err
  // Refuse to type into a pending CHOICE menu (plan/permission/AskUserQuestion):
  // Claude Code swallows the text and the trailing Enter accepts the highlighted
  // option — the operator's prompt is lost and a preselect is confirmed silently.
  // The card surfaces this and offers an explicit "dismiss menu (Esc) & send",
  // which Escapes the menu first and re-sends with `force` once it's gone.
  if (!force) {
    const pane = await captureTail(p.s, TAIL_LINES)
    if (menuKindOf(pane) === 'choice') return { status: 409, ok: false, error: 'menu', menuKind: 'choice' }
  }
  const d = await deliver(p.s, p.payload)
  if (!d.ok) return { status: 502, ok: false, error: d.error }
  // Attribute the next run to this prompt (phase tracker snapshots it on open).
  p.s.lastPrompt = { text: p.text, at: nowIso() }
  recordSteer(p.s, p.text, steeredBy)
  persist()
  audit({ action: 'prompt', id, repo: p.s.repo, len: p.payload.length, images: p.paths.length, ...(steeredBy ? { steeredBy } : {}), ok: true })
  return { status: 200, ok: true }
}

// Interrupt the in-flight turn and steer with added context. Escape stops the
// current generation but KEEPS the transcript so far (it's a turn boundary, not a
// reset), so after the settle delay the agent resumes with everything it had plus
// the new input. Same validation/payload as prompt.
export async function interrupt({ id, text, images, steeredBy }) {
  const p = await prepare(id, text, images)
  if (p.err) return p.err
  await run(['tmux', 'send-keys', '-t', p.s.tmux, 'Escape'])
  await sleep(INTERRUPT_SETTLE_MS)
  const d = await deliver(p.s, p.payload)
  if (!d.ok) return { status: 502, ok: false, error: d.error }
  // The Escape blip clears the busy marker briefly — hold the run phase so the
  // steer doesn't register as the turn ending; attribute the run to this input.
  p.s.phaseHold = Date.now() + PHASE_HOLD_MS
  p.s.lastPrompt = { text: p.text, at: nowIso() }
  recordSteer(p.s, p.text, steeredBy)
  persist()
  audit({ action: 'interrupt', id, repo: p.s.repo, len: p.payload.length, images: p.paths.length, ...(steeredBy ? { steeredBy } : {}), ok: true })
  return { status: 200, ok: true }
}

// Park a prompt to be delivered when the session next goes idle (the flush loop
// below does the sending). Appends to the session's FIFO queue, so queueing again
// while one is already parked keeps both (delivered in order). Images are saved now.
export async function queuePrompt({ id, text, images, kind, summary, steeredBy }) {
  const p = await prepare(id, text, images)
  if (p.err) return p.err
  if (!Array.isArray(p.s.queued)) p.s.queued = []
  if (p.s.queued.length >= MAX_QUEUED) return { status: 409, ok: false, error: `queue full (max ${MAX_QUEUED})` }
  p.s.queued.push({ text: p.text, paths: p.paths, ...(kind ? { kind } : {}), ...(summary ? { summary } : {}) })
  // Record now (by text); the parked prompt is delivered at the next idle and the
  // fingerprint matches whenever that turn lands in the transcript.
  recordSteer(p.s, p.text, steeredBy)
  persist()
  audit({ action: 'queue', id, repo: p.s.repo, len: p.payload.length, images: p.paths.length, depth: p.s.queued.length, ...(kind ? { kind } : {}), ok: true })
  return { status: 200, ok: true }
}

// One-sentence gist of a briefing for the card's ⏱ chip — a visual confirmation
// that the Atlas brief actually landed (debug aid; may be removed later). Flattens
// the markdown to prose, takes the first sentence, caps the length. Cosmetic and
// best-effort: returns '' when there's nothing usable.
function briefSummary(text) {
  const flat = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ') // drop fenced code blocks
    .split('\n')
    .map((l) => l.replace(/^[\s>#*+-]+/, '').trim()) // strip leading heading/list markers
    .filter(Boolean)
    .join(' ')
    .replace(/[*_`#]/g, '') // drop inline emphasis / leftover marks
    .replace(/\s+/g, ' ')
    .trim()
  if (!flat) return ''
  const end = flat.search(/[.!?](\s|$)/) // first sentence terminator (decimals/versions skipped)
  let s = end >= 0 ? flat.slice(0, end + 1) : flat
  if (s.length > 200) s = s.slice(0, 199).trimEnd() + '…'
  return s.trim()
}

// Background brief→queue (the non-blocking spawn path): wait for the paired
// worker's brief turn, then QUEUE the briefing for the dev agent so flushQueued
// delivers it at the first idle (never mid-turn). Tagged 'atlas-brief' so the card
// shows a shorthand ⏱ chip. Fire-and-forget from the spawn route. Skips if the
// brief failed/empty, the dev agent is gone, or the operator already parked a prompt.
export async function briefAndQueue({ workerId, devId }) {
  const brief = await briefWorker({ id: workerId })
  if (!brief.ok || !brief.text) return
  const dev = registry.sessions[devId]
  if (!dev || !(await sessionAlive(dev))) return
  if (Array.isArray(dev.queued) && dev.queued.length) {
    audit({ action: 'atlas-brief-queue', id: devId, ok: false, error: 'queue occupied' })
    return
  }
  await queuePrompt({
    id: devId,
    text: `## Relevant Atlas context\n_Prior knowledge from your Atlas knowledge base — treat any ⚠️ flags as constraints._\n\n${brief.text.trim()}`,
    kind: 'atlas-brief',
    summary: briefSummary(brief.text),
  })
}

// Cancel a parked prompt. With a numeric `index`, drop just that one from the
// FIFO queue (the card's per-chip ×); without one, clear the whole queue.
export async function unqueue({ id, index }) {
  const s = registry.sessions[id]
  if (!s) return { status: 404, ok: false, error: 'no such session' }
  if (Array.isArray(s.queued) && typeof index === 'number') {
    s.queued.splice(index, 1)
    if (!s.queued.length) delete s.queued
  } else {
    delete s.queued
  }
  persist()
  audit({ action: 'unqueue', id, repo: s.repo, ...(typeof index === 'number' ? { index } : {}), ok: true })
  return { status: 200, ok: true }
}

// Enqueue a dev session into the SERIAL ship train. The pump (on the flush
// timer) delivers `text` — the ship prompt the card built — once this member
// reaches the front AND the session is idle, then watches for ATLAS:SHIPPED
// before advancing to the next. Re-enqueuing an existing member just refreshes
// its text and keeps its place (idempotent — "ship all" can't create dupes).
// Box-local dev agents only: the train watches the on-disk transcript for the
// SHIPPED marker, and a knowledge chat has no PR to ship.
export function enqueueShip({ id, text }) {
  const s = registry.sessions[id]
  if (!s) return { status: 404, ok: false, error: 'no such session' }
  if (s.kind === 'knowledge') return { status: 400, ok: false, error: 'knowledge chats have no PR to ship' }
  if (typeof text !== 'string' || !text.trim()) return { status: 400, ok: false, error: 'ship prompt required' }
  if (text.length > 8000) return { status: 400, ok: false, error: 'ship prompt too long' }
  if (!s.lc) migrateSession(s)
  // Re-shipping a STUCK session: a prior ship that couldn't confirm its merge left
  // it in the needs_attention sink. Lift it back to a live state so the driver can
  // pick it up again — otherwise it would sit inert at the train head and wedge
  // every member behind it (the sink has no autonomous exit).
  if (isInert(s.lc.state)) {
    const prev = s.lc.state
    s.lc.state = mirrorState(s.shipState)
    s.lc.journal.push({ at: nowIso(), from: prev, to: s.lc.state, fact: 're_ship' })
  }
  // The durable ship INTENT lives on the session (survives a crash); the train is
  // the ORDER. The driver moves the head WORKING/SHIP_READY member to 'shipping'.
  s.lc.shipRequested = true
  s.lc.shipText = text
  const members = registry.shipTrain.members
  const i = members.findIndex((m) => m.id === id)
  if (i >= 0) {
    members[i].text = text // refresh the prompt, keep the place (idempotent "ship all")
    persist()
    return { status: 200, ok: true, position: i + 1 }
  }
  members.push({ id, text })
  persist()
  audit({ action: 'ship-enqueue', id, repo: s.repo, position: members.length, ok: true })
  if (DRIVE) driveAll().catch(() => {}) // start it now; the flush timer also drives it
  return { status: 200, ok: true, position: members.length }
}

// Drop a session from the ship train unconditionally (it's being killed/cleaned
// up) so it doesn't linger and skew the positions of the members behind it.
function removeFromShipTrain(id) {
  const members = registry.shipTrain.members
  const i = members.findIndex((m) => m.id === id)
  if (i >= 0) members.splice(i, 1)
}

// Remove a WAITING member from the ship train (cancel before it ships). The
// member currently merging (the active head) can't be yanked mid-flight.
export function unship({ id }) {
  const members = registry.shipTrain.members
  const i = members.findIndex((m) => m.id === id)
  if (i < 0) return { status: 404, ok: false, error: 'not in the ship queue' }
  const s = registry.sessions[id]
  if (i === 0 && shipActivelyMerging(s)) return { status: 409, ok: false, error: 'already shipping' }
  // The ship prompt is being delivered right now (acting) — its post-await write
  // would race this unship. Refuse; it lands as 'shipping' a beat later.
  if (acting.has(id)) return { status: 409, ok: false, error: 'shipping step in progress — retry in a moment' }
  members.splice(i, 1)
  if (s && s.lc) {
    delete s.lc.shipRequested
    delete s.lc.shipText
    delete s.lc.shipBaseline
    delete s.lc.shipPromptedAt
    delete s.lc.shipSawBusy
    // It may have just entered SHIPPING (head, not yet prompted) — drop it back to
    // a live state so the driver stops trying to ship it.
    if (s.lc.state === LC.SHIPPING) s.lc.state = mirrorState(s.shipState)
  }
  persist()
  audit({ action: 'ship-unqueue', id, repo: s && s.repo, ok: true })
  return { status: 200, ok: true }
}

// Deliver the NEXT queued prompt (FIFO head) RIGHT NOW instead of waiting for the
// turn to end — the operator's "send now" on the ⏱ chip. Mirrors interrupt():
// Escape the in-flight turn (work so far is kept), settle, then send the parked
// payload. The head is claimed synchronously BEFORE any await so the flush timer
// can't also grab it (single-threaded: the sync prefix runs atomically vs the
// timer); restored to the front if the session is gone or the send fails.
export async function sendNow({ id }) {
  const s = registry.sessions[id]
  if (!s) return { status: 404, ok: false, error: 'no such session' }
  if (!Array.isArray(s.queued) || !s.queued.length) return { status: 409, ok: false, error: 'nothing queued' }
  const q = s.queued.shift()
  if (!s.queued.length) delete s.queued
  persist()
  if (!(await sessionAlive(s))) {
    s.queued = [q, ...(s.queued || [])]
    persist()
    return { status: 409, ok: false, error: 'session not running' }
  }
  const payload = withImages(q.text || '', q.paths || [])
  await run(['tmux', 'send-keys', '-t', s.tmux, 'Escape'])
  await sleep(INTERRUPT_SETTLE_MS)
  const d = await deliver(s, payload)
  if (!d.ok) {
    s.queued = [q, ...(s.queued || [])]
    persist()
    return { status: 502, ok: false, error: d.error }
  }
  // Same as interrupt: hold the run across the Escape blip and attribute it.
  s.phaseHold = Date.now() + PHASE_HOLD_MS
  s.lastPrompt = { text: q.text || '', at: nowIso() }
  persist()
  audit({ action: 'queue-send-now', id, repo: s.repo, len: payload.length, images: (q.paths || []).length, ok: true })
  return { status: 200, ok: true }
}

// Deliver any queued prompts whose session has gone idle. Runs on a timer (not
// just on the GET poll) so a queued prompt fires even with the dashboard closed.
// Skips sessions still working (busy marker) or parked on a menu (text would land
// in the menu, not as a prompt). Re-entrancy-guarded; a failed send retries next tick.
let flushing = false
async function flushQueued() {
  if (flushing) return
  flushing = true
  try {
    const shipHead = shipHeadActiveId()
    for (const s of Object.values(registry.sessions)) {
      if (!Array.isArray(s.queued) || !s.queued.length || s.status === 'error') continue
      // Don't deliver a parked prompt into an in-flight ship — it would land
      // mid git-merge. The ship train delivers the ship prompt itself; this
      // member's other queued prompt waits until it leaves the train.
      if (s.id === shipHead) continue
      if (!(await sessionAlive(s))) continue
      const pane = await captureTail(s, TAIL_LINES)
      if (isBusy(pane) || menuKindOf(pane)) continue
      // One per idle tick: deliver the FIFO head, then leave the rest for later
      // ticks (the agent goes busy on this one, so the next won't fire until it's
      // idle again — each queued prompt gets its own turn, in order).
      const q = s.queued[0]
      const payload = withImages(q.text || '', q.paths || [])
      const d = await deliver(s, payload)
      if (!d.ok) continue
      s.lastPrompt = { text: q.text || '', at: nowIso() }
      s.queued.shift()
      if (!s.queued.length) delete s.queued
      persist()
      audit({ action: 'queue-flush', id: s.id, repo: s.repo, len: payload.length, images: (q.paths || []).length, ok: true })
    }
  } finally {
    flushing = false
  }
}

/* ── Lifecycle driver ───────────────────────────────────────────────────────
 * ONE loop advances every box-local session one step per tick and persists,
 * subsuming the old ship-train pump, the reaper (reapClosing/stepDevClose), and
 * the inline Atlas merge. The DECISION is pure (agent-lifecycle.mjs `decide`); the
 * IO lives here — `gatherFacts` re-derives the durable truth each tick and the
 * `ACTS` table performs the named side effects. "Crash recovery" needs no special
 * path: a restarted process just keeps driving from the persisted state. */

// Sessions with a lifecycle ACT in flight — its IO is mid-await (delivering a
// ship/recap/ingest prompt, or merging the Atlas branch). The acts are
// self-transitions that write s.lc AFTER their awaits, so an operator abort/unship
// landing in that window would race them. abortClose/unship refuse while a session
// is here; the act finishes in a beat (a merge can take longer, which is correct —
// a merge in progress genuinely can't be called back). In-memory only: a crash
// clears it and the act re-runs cleanly on reload.
const acting = new Set()

// Has the close turn we're waiting on (`target`) finished? Mirrors the old
// stepDevClose/reapClosing windows: done when the target is gone, has gone idle
// after we saw it work (or past the no-start grace), or blew the hard timeout.
// Latches lc.sawBusy (persisting) the first time we observe it busy.
async function closeTurnDone(target, anchorIso, lc) {
  const since = Date.now() - Date.parse(anchorIso || nowIso())
  if (target && (await sessionAlive(target))) {
    if (isBusy(await captureTail(target, TAIL_LINES))) {
      if (!lc.sawBusy) { lc.sawBusy = true; persist() }
      return since >= KNOWLEDGE_CLOSE_TIMEOUT_MS // still running unless it blew the cap
    }
    if (!lc.sawBusy && since < KNOWLEDGE_CLOSE_GRACE_MS) return false // turn hasn't visibly started
  }
  return true // target gone / idle after the turn / past grace
}

// Gather the durable facts the pure `decide` needs for `s`, doing only the IO the
// session's current state actually requires — a QUIESCENT agent costs no tmux
// call (its lifecycle is just a mirror of the ship marker the poll maintains).
async function gatherFacts(s) {
  const lc = s.lc
  const st = lc.state
  const f = { now: Date.now(), shipState: s.shipState }

  if (QUIESCENT.has(st)) {
    f.shipRequested = !!lc.shipRequested
    f.isShipHead = isShipHead(s)
    return f
  }
  if (st === LC.SPAWNED) {
    f.alive = await sessionAlive(s)
    if (!f.alive) f.hasTranscript = !!resumeId(s)
    return f
  }
  if (st === LC.SHIPPING) {
    f.alive = await sessionAlive(s)
    if (f.alive) {
      const pane = await captureTail(s, TAIL_LINES)
      f.busy = isBusy(pane)
      f.menu = !!menuKindOf(pane)
      if (f.busy && lc.shipPromptedAt && !lc.shipSawBusy) { lc.shipSawBusy = true; persist() }
    }
    // DURABLE merged fact: a ATLAS:SHIPPED marker NEWER than the baseline.
    const tr = readTranscript(s)
    const cur = tr && tr.ship ? `${tr.ship.state}|${tr.ship.info}` : ''
    f.shipMarkerAdvanced = !!(tr && tr.ship && tr.ship.state === 'shipped' && cur !== (lc.shipBaseline || ''))
    if (lc.shipPromptedAt) {
      const since = f.now - Date.parse(lc.shipPromptedAt)
      f.shipTimedOut = since > SHIP_TURN_TIMEOUT_MS
      f.shipStartGraceElapsed = since > SHIP_START_GRACE_MS
    }
    return f
  }
  if (st === LC.INGESTING) {
    const worker = s.atlasWorker ? registry.sessions[s.atlasWorker] : null
    if (lc.closePhase === 'ingest') {
      f.closeTurnDone = await closeTurnDone(worker, lc.ingestAt || lc.closingAt, lc)
    } else {
      // recap (dev writes it) OR knowledge/unpaired wrap-up — both watch `s`.
      f.closeTurnDone = await closeTurnDone(s, lc.closingAt, lc)
      f.workerAlive = !!(worker && (await sessionAlive(worker)))
    }
    return f
  }
  // INGESTED / REAPING / sinks need no IO — `decide` advances them on the state.
  return f
}

// The named side effects (keyed in agent-lifecycle.mjs). Re-running an act after a
// crash is safe in the normal case (the durable-fact gate keeps the decision the
// same). The one residual gap is exactly-once PROMPT DELIVERY: a crash in the
// microsecond window between a successful tmux send and the following persist can
// re-deliver the ship/ingest prompt on reload (a benign duplicate turn / a second
// Wiki/log.md line) — accepted, since a tmux keystroke can't be made transactional
// with the state write.
const ACTS = {
  // Snapshot the ship-marker baseline before we prompt, so a later ATLAS:SHIPPED
  // is unambiguously NEW.
  [ACT.ENTER_SHIPPING]: async (s) => {
    const tr = readTranscript(s)
    s.lc.shipBaseline = tr && tr.ship ? `${tr.ship.state}|${tr.ship.info}` : ''
    s.lc.shipSawBusy = false
    persist()
  },
  // Type the ship prompt into the (now idle) session. shipPromptedAt is set ONLY
  // on a successful send, so a failed send simply retries next tick.
  [ACT.DELIVER_SHIP]: async (s) => {
    const m = registry.shipTrain.members.find((x) => x.id === s.id)
    const text = (m && m.text) || s.lc.shipText
    if (!text) return
    const d = await deliver(s, text)
    if (!d.ok) return // retry next tick
    s.lc.shipPromptedAt = nowIso()
    s.lastPrompt = { text: '(ship)', at: nowIso() }
    audit({ action: 'ship-deliver', id: s.id, repo: s.repo, ok: true })
    persist()
  },
  // Leave the train (shipped OR couldn't-confirm). The lifecycle state (shipped /
  // needs_attention) already records the outcome; clear the ship bookkeeping.
  [ACT.LEAVE_SHIP]: async (s) => {
    const shipped = s.lc.state === LC.SHIPPED
    removeFromShipTrain(s.id)
    delete s.lc.shipRequested
    delete s.lc.shipText
    delete s.lc.shipBaseline
    delete s.lc.shipPromptedAt
    delete s.lc.shipSawBusy
    audit({ action: shipped ? 'ship-done' : 'ship-stop', id: s.id, repo: s.repo, info: s.shipInfo, ok: true })
    persist()
  },
  // Capture the dev recap and hand it to the paired worker (→ closePhase ingest).
  // If there's nothing to ingest (no worker / no recap / send failed), correct to
  // reaping in place.
  [ACT.HAND_TO_WORKER]: async (s) => {
    const worker = s.atlasWorker ? registry.sessions[s.atlasWorker] : null
    const recap = (await sessionAlive(s)) ? lastAssistantText(s) : ''
    if (worker && recap && (await sessionAlive(worker))) {
      await run(['tmux', 'send-keys', '-t', worker.tmux, 'Escape'])
      await sleep(INTERRUPT_SETTLE_MS)
      const d = await deliver(worker, atlasIngestPrompt(recap, s))
      if (d.ok) {
        s.lc.closePhase = 'ingest'
        s.lc.ingestAt = nowIso()
        s.lc.sawBusy = false
        audit({ action: 'close-ingest', id: s.id, worker: worker.id, recapLen: recap.length, ok: true })
        persist()
        return
      }
    }
    // Nothing to ingest → straight to teardown.
    s.lc.journal.push({ at: nowIso(), from: LC.INGESTING, to: LC.REAPING, fact: 'recap_handoff_failed' })
    s.lc.state = LC.REAPING
    persist()
  },
  // Merge the worker's atlas branch + reap the worker, THEN advance to `ingested`.
  // Runs while still in `ingesting/ingest` (the write-ahead marker), so a crash
  // mid-merge re-runs the merge instead of losing the ingest. A real conflict KEEPS
  // the branch (the ingest commit lives only there) and drops the worker from the
  // live list — exactly what the old finishDevClose did.
  [ACT.MERGE_ATLAS]: async (s) => {
    const worker = s.atlasWorker ? registry.sessions[s.atlasWorker] : null
    const merge = worker ? await enqueueAtlasMerge({ branch: worker.branch, message: `atlas: ingest from ${s.id}` }) : null
    s.lc.mergeWarning = merge && merge.warning ? merge.warning : undefined
    if (worker) {
      if (merge && !merge.ok) {
        await run(['tmux', 'kill-session', '-t', worker.tmux])
        recordLifetime(worker, Date.now())
        delete registry.sessions[worker.id]
        audit({ action: 'close-worker-kept', id: worker.id, branch: worker.branch, worktree: worker.worktree, warning: merge.warning, ok: true })
      } else {
        await cleanup({ id: worker.id }).catch(() => {})
      }
    }
    s.lc.journal.push({ at: nowIso(), from: LC.INGESTING, to: LC.INGESTED, fact: 'atlas_merged' })
    s.lc.state = LC.INGESTED
    persist()
  },
  // Final teardown (the old finishDevClose / reapClosing reap): kill tmux, remove
  // artifacts on a ⌦-close, reap any still-present paired worker, record the
  // lifetime, drop from the train, and DELETE the entry (== reaped).
  [ACT.REAP]: async (s) => {
    const worker = s.atlasWorker ? registry.sessions[s.atlasWorker] : null
    if (worker) await cleanup({ id: worker.id }).catch(() => {}) // only present on the no-merge paths
    if (await sessionAlive(s)) await run(['tmux', 'kill-session', '-t', s.tmux])
    if (s.lc.cleanupOnClose) await removeAgentArtifacts(s)
    recordLifetime(s, Date.now())
    removeFromShipTrain(s.id)
    const wrapUpMs = s.lc.closingAt ? Date.now() - Date.parse(s.lc.closingAt) : undefined
    audit({
      action: 'close-reap', id: s.id, repo: s.repo, kind: s.kind || 'dev',
      merged: !s.lc.mergeWarning, warning: s.lc.mergeWarning, cleanup: !!s.lc.cleanupOnClose,
      ...(wrapUpMs != null ? { wrapUpMs } : {}), ok: true,
    })
    delete registry.sessions[s.id]
    persist()
  },
}

// Move a session into the graceful close flow (ingesting). The caller has already
// delivered the entry prompt (the recap request, or the knowledge wrap-up); the
// driver then advances recap → ingest → merge → reap. `phase` is 'recap' for a
// paired dev agent, undefined for a knowledge/unpaired wrap-up.
function beginClose(s, { phase, cleanup } = {}) {
  const from = s.lc ? s.lc.state : null
  if (!s.lc) s.lc = initLifecycle(LC.WORKING)
  s.lc.journal.push({ at: nowIso(), from, to: LC.INGESTING, fact: 'close_requested' })
  if (s.lc.journal.length > 40) s.lc.journal.splice(0, s.lc.journal.length - 40)
  s.lc.state = LC.INGESTING
  s.lc.closingAt = nowIso()
  if (phase) s.lc.closePhase = phase
  else delete s.lc.closePhase
  s.lc.sawBusy = false
  if (cleanup) s.lc.cleanupOnClose = true
  delete s.lc.shipRequested // a close supersedes a pending ship request
  removeFromShipTrain(s.id)
  persist()
}

// Advance ONE session one step. Crash-safe: write-ahead (state journaled +
// persisted) BEFORE the act runs.
async function driveSession(s) {
  if (!s.lc) migrateSession(s)
  if (isInert(s.lc.state)) return // needs_attention / reaped — only an operator moves these
  if (s.status === 'error' || s.status === 'dormant') return // not driven (errored / parked)
  if (s.kind === 'atlas') return // paired/standalone workers are owned by the dev close / ingestToAtlas
  const before = s.lc.state
  const facts = await gatherFacts(s)
  // An operator action (kill / abortClose / unship) may have moved the state during
  // our await — bail and re-evaluate next tick rather than act on a stale decision.
  if (s.lc.state !== before) return
  const d = decide(s, facts)
  if (!d) return
  if (d.to === LC.REAPED) {
    // REAPED is "deleted" — never persisted. REAPING was the write-ahead marker;
    // the reap act tears down + deletes (idempotent), staying in REAPING on failure
    // so the next tick retries.
    acting.add(s.id)
    try {
      await ACTS[ACT.REAP](s)
    } catch (e) {
      console.error('[lifecycle] reap failed:', e.message)
    } finally {
      acting.delete(s.id)
    }
    return
  }
  const act = applyTransition(s, d, nowIso()) // write-ahead: state + journal…
  persist() // …persisted BEFORE the side effect
  if (act && ACTS[act]) {
    // Hold the act lock across its awaits so an operator abort/unship can't race
    // the act's post-await write to s.lc (see `acting`).
    acting.add(s.id)
    try {
      await ACTS[act](s)
    } catch (e) {
      console.error(`[lifecycle] act ${act} failed:`, e.message)
    } finally {
      acting.delete(s.id)
    }
  }
}

// One pass over every session. Re-entrancy-guarded; prunes dead ship-train members
// first so the head is always shippable. Runs on the flush timer (so it advances
// with the dashboard closed) and is kicked directly by enqueueShip.
let driving = false
async function driveAll() {
  if (driving) return
  driving = true
  try {
    if (pruneShipTrain()) persist()
    for (const s of Object.values(registry.sessions)) await driveSession(s)
  } finally {
    driving = false
  }
}
// ───────────────────────────────────────────────────────────────────────────
// Graceful close for knowledge chats: the first ✕ delivers this wrap-up prompt
// (single line — newlines would submit early in the TUI) instead of killing, so
// insights that only exist in the transcript get worked into the vault before
// the session goes away. The reaper below kills the session once that final
// turn finishes; a second ✕ while closing force-kills at once.
const KNOWLEDGE_CLOSE_PROMPT =
  process.env.AGENT_KNOWLEDGE_CLOSE_PROMPT ||
  'This chat is being closed. Final turn: if this conversation produced insights, corrections, or research findings that are NOT yet in the vault, work them in now — add-and-link per your protocol, valid frontmatter, then pull-rebase, commit only your files, and push. If everything durable is already saved (or nothing came up), just reply "nothing to save". Keep it brief — the session ends when you finish.'
// The Atlas chat closes the TYPED way: the wrap-up folds insights into the Atlas
// with the typed edges/dates the operator could later query, consults the Legend
// (reuse-or-register keys), and logs the ingest — not just an add-and-link note.
const ATLAS_KNOWLEDGE_CLOSE_PROMPT =
  process.env.AGENT_ATLAS_KNOWLEDGE_CLOSE_PROMPT ||
  'This chat is being closed. Final turn — two things. FIRST, tidy up the dev agents you spawned. cleanup_agent is the ⌦ teardown — it force-deletes the branch — so run it ONLY on an agent whose work is already SHIPPED/merged (check shipState in list_agents): it recaps → logs the session to the Atlas → removes the worktree + branch, leaving no orphan. For any spawned agent whose work is NOT yet shipped, do NOT delete it — leave it running and ASK the operator to confirm cleanup (name it here and send_message them), since its branch would otherwise be lost. SECOND, if this conversation produced insights, corrections, or research findings NOT yet in the Atlas, work them in now the TYPED way — update the most fitting page (or add one focused page), and think QUERY-FIRST: add the typed edges + dates the operator would later filter/traverse for (consult Wiki/Legend.md first; reuse a registered snake_case key, or coin + register a new one in the SAME edit), overwrite live state in place, and append a Wiki/log.md entry (## [YYYY-MM-DD] ingest | <title>). Then pull-rebase, commit only your files, and push. If everything durable is already saved (or nothing came up), just reply "nothing to save". Keep it brief — the session ends when you finish.'
// Don't reap before the wrap-up turn has had a chance to START (the busy marker
// takes a moment to appear after the prompt is typed)...
const KNOWLEDGE_CLOSE_GRACE_MS = Number(process.env.AGENT_KNOWLEDGE_CLOSE_GRACE_MS || 20000)
// ...and never let a wedged wrap-up hold the session forever (vault writes made
// before the cap land on disk either way; only the final commit could be lost).
const KNOWLEDGE_CLOSE_TIMEOUT_MS = Number(process.env.AGENT_KNOWLEDGE_CLOSE_TIMEOUT_MS || 10 * 60 * 1000)

// Box dev agents with a paired Atlas worker close in two phases (see
// the paired-worker design): on the first ✕ the dev agent gets
// this recap prompt; the reaper captures the reply and hands it to the worker to
// ingest. Reuses the KNOWLEDGE_CLOSE_* grace/timeout windows.
const DEV_RECAP_PROMPT =
  process.env.AGENT_DEV_RECAP_PROMPT ||
  'This session is closing. Final turn — no tools, no edits: reply with a TIGHT recap of THIS session for the Atlas knowledge base. What changed and why, the key decisions and any dead-ends, and anything that CONTRADICTS what the Atlas briefing told you at the start. A few sentences or a short list — durable knowledge only, not a play-by-play. The session ends when you finish.'

// The ingest prompt handed to the paired worker once the dev recap is captured.
function atlasIngestPrompt(recap, dev) {
  return `The dev agent you briefed (\`${dev.id}\`, branch \`${dev.branch}\`, worktree \`${dev.worktree}\`) has finished. Its session recap:\n\n${recap}\n\nINGEST this per your INGEST instructions: update the most fitting page and ALWAYS append at least one Wiki/log.md entry; note any contradiction with what the Atlas previously claimed. If the recap names a concrete follow-up/next-step or the dev task was an explicit "add a task" request, also file a focused Tasks/<slug>.md tagged to its project (\`for_project: "[[<Project>]]"\`, matched against Wiki/Projects/) so it lands on the Kanban. You may read the dev branch's diff for detail. Commit to YOUR branch with a clear message — do NOT push and do NOT touch main; the dashboard merges your branch. End with ATLAS:INGESTED on its own line.`
}

// Ingest prompt for a REMOTE (workstation) dev agent. Same INGEST contract, but
// the dev agent ran in a container the box can't reach — so the worker works from
// the recap ALONE (it cannot read the remote diff).
function atlasIngestPromptRemote(recap, dev) {
  return `A dev agent (\`${dev.id}\`${dev.task ? `, task: "${dev.task}"` : ''}) running on a remote workstation has finished. Its session recap:\n\n${recap}\n\nINGEST this per your INGEST instructions: update the most fitting page and ALWAYS append at least one Wiki/log.md entry; note any contradiction with what the Atlas previously claimed. If the recap names a concrete follow-up/next-step or the dev task was an explicit "add a task" request, also file a focused Tasks/<slug>.md tagged to its project (\`for_project: "[[<Project>]]"\`, matched against Wiki/Projects/) so it lands on the Kanban. The dev agent ran on a remote box, so work ONLY from this recap — you cannot read its diff. Commit to YOUR branch with a clear message — do NOT push and do NOT touch main; the dashboard merges your branch. End with ATLAS:INGESTED on its own line.`
}

// Ephemeral Atlas ingest for a REMOTE (workstation) dev agent's session recap.
// Workstation agents are briefed at spawn but their worker is reaped immediately
// (no box-side session to keep it paired to). So at close we spin up a SHORT-LIVED
// Atlas worker whose FIRST turn is the ingest, wait for it to commit on its branch,
// merge that branch into the Atlas, and reap it. The worker is box-local, so the
// box's pane/transcript helpers work even though the dev agent itself was remote.
// `preamble` is supplied by the caller (agent-routes owns ATLAS_WORKER_PREAMBLE).
// Best-effort: returns { ok:false } when the atlas is off or the recap is empty,
// so the remote close degrades to a plain kill.
export async function ingestToAtlas({ recap, devId, devTask, preamble }) {
  if (!atlasAvailable()) return { ok: false, error: 'atlas not configured' }
  const text = (recap || '').trim()
  if (!text) return { ok: false, error: 'empty recap' }
  const firstTurn = atlasIngestPromptRemote(text, { id: devId, task: devTask })
  const w = await spawnAtlasWorker({ task: devTask || `ingest ${devId}`, preamble, firstTurn })
  if (!w.ok || !w.id) return { ok: false, error: w.error || 'worker spawn failed' }
  const worker = registry.sessions[w.id]
  // Unlike a box-paired worker (which hides behind its dev agent's card), this one
  // has no box dev card to attach to — the dev agent is remote — so mark it
  // STANDALONE to surface it as its own short-lived node in the agents overview.
  worker.standalone = true
  persist()
  // Wait for the ingest turn to finish (busy→idle, or a fast turn caught by the
  // grace), bounded by the same window a graceful close uses.
  const started = Date.now()
  let sawBusy = false
  while (Date.now() - started < KNOWLEDGE_CLOSE_TIMEOUT_MS) {
    await sleep(ATLAS_BRIEF_POLL_MS)
    if (!(await sessionAlive(worker))) break
    if (isBusy(await captureTail(worker, TAIL_LINES))) { sawBusy = true; continue }
    if (sawBusy || Date.now() - started > ATLAS_BRIEF_GRACE_MS) break
  }
  const merge = await enqueueAtlasMerge({ branch: worker.branch, message: `atlas: ingest from ${devId}` })
  if (merge && !merge.ok) {
    // A real page-rewrite conflict — KEEP the branch (the ingest commit lives only
    // there) for manual resolution; just end the tmux + drop it from the live list.
    await run(['tmux', 'kill-session', '-t', worker.tmux])
    recordLifetime(worker, Date.now())
    delete registry.sessions[worker.id]
    persist()
    audit({ action: 'close-worker-kept', id: worker.id, branch: worker.branch, worktree: worker.worktree, warning: merge.warning, remote: devId, ok: true })
  } else {
    await cleanup({ id: worker.id }).catch(() => {})
  }
  audit({ action: 'remote-atlas-ingest', id: devId, worker: worker.id, recapLen: text.length, merged: !!(merge && merge.ok), warning: merge && merge.warning, ok: true })
  return { ok: true, merged: !!(merge && merge.ok), warning: merge && merge.warning }
}

// Sample every session's live-stats file. On the timer (not the GET poll) so a
// long job's plot keeps accruing points with the dashboard closed; mtime-gated,
// so an idle file costs one statSync per tick.
function sampleAllStats() {
  let changed = false
  for (const s of Object.values(registry.sessions)) {
    if (s.status !== 'error' && sampleLiveStats(s)) changed = true
  }
  if (changed) persist()
}

// Sample every live session's status on the timer (not just the GET poll) so the
// run/wait phase timer advances and a finished agent gets its lifetime record
// even with the dashboard closed. Re-entrancy-guarded; one pane capture per live
// session per tick — the same cost listSessions pays while the card is open. The
// phase tracker is idempotent, so doing it here AND in listSessions is safe.
let samplingPhases = false
async function samplePhases() {
  if (samplingPhases) return
  samplingPhases = true
  let changed = false
  try {
    const now = Date.now()
    for (const s of Object.values(registry.sessions)) {
      if (s.status === 'error' || s.lifetimeLogged) continue
      if (!(await sessionAlive(s))) {
        if (recordLifetime(s, now)) changed = true
        continue
      }
      const pane = await captureTail(s, TAIL_LINES)
      if (trackPhase(s, isBusy(pane) ? 'running' : 'idle', now)) changed = true
    }
  } finally {
    samplingPhases = false
    if (changed) persist()
  }
}

const flushTimer = setInterval(() => {
  flushQueued().catch(() => {})
  if (DRIVE) driveAll().catch(() => {}) // the one lifecycle driver (subsumes ship-train + reaper)
  sampleAllStats()
  samplePhases().catch(() => {})
}, QUEUE_FLUSH_MS)
if (flushTimer.unref) flushTimer.unref() // don't keep the process alive for this

// Crash self-heal: once the process is up, re-attach any sessions a tmux-server
// death orphaned (capped + staggered — see reconcileOrphans). Delayed so Express
// finishes starting; best-effort so a hiccup never blocks boot.
if (RECONCILE) {
  const reconcileTimer = setTimeout(() => reconcileOrphans().catch(() => {}), RECONCILE_BOOT_DELAY_MS)
  if (reconcileTimer.unref) reconcileTimer.unref()
}

// Allowlisted tmux key tokens for driving Claude Code's interactive menus
// (arrow-select prompts, plan approval, the rare permission dialog). Sent
// WITHOUT `-l`, so tmux interprets the names; Enter is an explicit key here, not
// auto-appended like the free-text `prompt` path. The allowlist is the boundary
// — no arbitrary key string reaches tmux.
const ALLOWED_KEYS = new Set([
  'Up', 'Down', 'Left', 'Right', 'Enter', 'Escape', 'Space', 'Tab',
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
])

export async function keys({ id, keys: ks }) {
  const s = registry.sessions[id]
  if (!s) return { status: 404, ok: false, error: 'no such session' }
  if (!Array.isArray(ks) || !ks.length) return { status: 400, ok: false, error: 'keys required' }
  if (ks.length > 16) return { status: 400, ok: false, error: 'too many keys' }
  for (const k of ks)
    if (!ALLOWED_KEYS.has(k)) return { status: 400, ok: false, error: `key not allowed: ${k}` }
  if (!(await sessionAlive(s))) return { status: 409, ok: false, error: 'session not running' }
  const r = await run(['tmux', 'send-keys', '-t', s.tmux, ...ks])
  if (!r.ok) return { status: 502, ok: false, error: r.stderr.slice(0, 500) || 'send-keys failed' }
  // A menu confirmation can unblock a run — attribute it (no free-text prompt).
  s.lastPrompt = { text: '(menu choice)', at: nowIso() }
  persist()
  audit({ action: 'keys', id, repo: s.repo, keys: ks, ok: true })
  return { status: 200, ok: true }
}

export async function kill({ id }) {
  const s = registry.sessions[id]
  if (!s) return { status: 404, ok: false, error: 'no such session' }
  // Knowledge chats close GRACEFULLY on the first ✕: interrupt whatever runs
  // (work so far is kept), deliver the wrap-up prompt (flush unsaved insights
  // to the vault), and let the reaper kill the session when that turn ends.
  // A second ✕ while closing falls through to the immediate kill below.
  if (s.kind === 'knowledge' && !isClosing(s.lc?.state) && (await sessionAlive(s))) {
    delete s.queued // a parked prompt would land after the wrap-up — drop it
    await run(['tmux', 'send-keys', '-t', s.tmux, 'Escape'])
    await sleep(INTERRUPT_SETTLE_MS)
    // Typed vaults (atlas, a sibling vault, … — those carrying a Wiki/Legend.md)
    // flush insights the TYPED way (typed edges/dates + Legend + log).
    const closePrompt = isTypedVault(s.vault) ? ATLAS_KNOWLEDGE_CLOSE_PROMPT : KNOWLEDGE_CLOSE_PROMPT
    const d = await deliver(s, closePrompt)
    if (d.ok) {
      beginClose(s) // → ingesting (no closePhase); the driver reaps when the wrap-up turn ends
      audit({ action: 'close', id, repo: s.repo, ok: true })
      return { status: 200, ok: true, closing: true }
    }
    // Couldn't deliver the wrap-up — fall through to the hard kill.
  }
  // Box dev agents WITH a paired Atlas worker also close GRACEFULLY on the first ✕:
  // ask the dev agent for a session recap, then the lifecycle driver runs recap →
  // worker ingest → enqueueAtlasMerge → reap both. A second ✕ (already `ingesting`)
  // falls through to the force-kill below (which reaps the worker WITHOUT ingesting).
  if (s.atlasWorker && registry.sessions[s.atlasWorker] && !isClosing(s.lc?.state) && (await sessionAlive(s))) {
    delete s.queued
    await run(['tmux', 'send-keys', '-t', s.tmux, 'Escape'])
    await sleep(INTERRUPT_SETTLE_MS)
    const d = await deliver(s, DEV_RECAP_PROMPT)
    if (d.ok) {
      beginClose(s, { phase: 'recap' }) // → ingesting/recap; the driver runs recap → ingest → merge → reap
      audit({ action: 'close', id, repo: s.repo, kind: 'dev', ok: true })
      return { status: 200, ok: true, closing: true }
    }
    // delivery failed — fall through to the force-kill (+ worker reap) below
  }
  // tmux only — the worktree + agent/<id> branch persist for review/merge.
  await run(['tmux', 'kill-session', '-t', s.tmux])
  // Force path (second ✕ / no worker / delivery failed): reap the paired Atlas
  // worker too, WITHOUT an ingest (the graceful path above is where ingest runs).
  if (s.atlasWorker && registry.sessions[s.atlasWorker]) await cleanup({ id: s.atlasWorker }).catch(() => {})
  recordLifetime(s, Date.now())
  removeFromShipTrain(id)
  delete registry.sessions[id]
  persist()
  audit({ action: 'kill', id, repo: s.repo, branch: s.branch, worktree: s.worktree, ok: true })
  return { status: 200, ok: true }
}

// Remove a dev agent's on-disk artifacts: its git worktree + branch, plus any
// uploads/stats files. (Knowledge agents have none — their "worktree" IS the
// vault root.) Shared by cleanup() and the ⌦-initiated graceful close.
async function removeAgentArtifacts(s) {
  if (s.kind !== 'knowledge') {
    await run(['git', '-C', s.path, 'worktree', 'remove', s.worktree, '--force'])
    await run(['git', '-C', s.path, 'branch', '-D', s.branch])
  }
  try {
    fs.rmSync(path.join(STATE_DIR, 'uploads', s.id), { recursive: true, force: true })
    fs.rmSync(statsFile(s.id), { force: true })
  } catch {
    /* best-effort: leftover upload/stats files are harmless */
  }
}

// kill + REMOVE the worktree + DELETE the branch — for an agent whose work is
// merged or abandoned. Destructive (the branch is gone); the card confirms first.
export async function cleanup({ id }) {
  const s = registry.sessions[id]
  if (!s) return { status: 404, ok: false, error: 'no such session' }
  // A paired box dev agent cleans up GRACEFULLY too — just like the first ✕: ask
  // for a recap, let the driver run recap → worker ingest → merge to the Atlas,
  // THEN tear down. cleanupOnClose tells the reap act to ALSO remove the worktree
  // + branch when it finishes (a plain ✕ keeps them for review). So the operator's
  // usual ⌦ still logs the session to the Atlas. (Same close machinery as kill().)
  if (isClosing(s.lc?.state) && s.lc.closePhase) {
    // A graceful close is already underway (an earlier ✕/⌦) — don't abort the
    // in-flight ingest; just ensure the worktree + branch are removed when it ends.
    s.lc.cleanupOnClose = true
    persist()
    return { status: 200, ok: true, closing: true }
  }
  if (s.atlasWorker && registry.sessions[s.atlasWorker] && (await sessionAlive(s))) {
    delete s.queued
    await run(['tmux', 'send-keys', '-t', s.tmux, 'Escape'])
    await sleep(INTERRUPT_SETTLE_MS)
    const d = await deliver(s, DEV_RECAP_PROMPT)
    if (d.ok) {
      beginClose(s, { phase: 'recap', cleanup: true })
      audit({ action: 'close', id, repo: s.repo, kind: 'dev', cleanup: true, ok: true })
      return { status: 200, ok: true, closing: true }
    }
    // delivery failed — fall through to the immediate teardown below
  }
  await run(['tmux', 'kill-session', '-t', s.tmux])
  // Reap the paired Atlas worker too (no ingest on this path). Workers have no
  // atlasWorker of their own, so this never recurses.
  if (s.atlasWorker && registry.sessions[s.atlasWorker]) await cleanup({ id: s.atlasWorker }).catch(() => {})
  await removeAgentArtifacts(s)
  recordLifetime(s, Date.now())
  removeFromShipTrain(id)
  delete registry.sessions[id]
  persist()
  audit({ action: 'cleanup', id, repo: s.repo, branch: s.branch, worktree: s.worktree, ok: true })
  return { status: 200, ok: true }
}

// Abort an in-flight graceful close (the operator pressed ✕/⌦ — often on the
// WRONG agent — and wants it back). Only valid while closing: interrupt the
// wrap-up/recap turn (and the paired worker's ingest turn, if it already
// started), clear every close marker, and leave the session, its worktree +
// branch, and its worker untouched and running. Nothing is reaped or removed —
// the operator can re-close cleanly later. The driver's `if (s.lc.state !== before)`
// re-check makes this safe against a step that's mid-flight.
export async function abortClose({ id }) {
  const s = registry.sessions[id]
  if (!s) return { status: 404, ok: false, error: 'no such session' }
  // Only the `ingesting` phase is abortable — once the Atlas merge / reap have
  // started (ingested / reaping) there's nothing left to call back.
  if (s.lc?.state !== LC.INGESTING) return { status: 409, ok: false, error: 'not closing' }
  // A close STEP (recap→worker handoff, or the Atlas merge) is mid-flight: it's
  // about to write s.lc, so aborting now would race it. Refuse; the step finishes
  // in a moment (the merge, once running, genuinely can't be called back).
  if (acting.has(id)) return { status: 409, ok: false, error: 'a close step is in progress — retry in a moment' }
  // Stop the in-flight wrap-up turn so the agent returns to idle, ready to take
  // normal prompts again. (Sent directly, not via interrupt() — abort must not
  // mark the session "interrupted/lost".)
  if (await sessionAlive(s)) await run(['tmux', 'send-keys', '-t', s.tmux, 'Escape'])
  // If the paired worker already started ingesting (ingest phase), stop it too.
  const worker = s.atlasWorker ? registry.sessions[s.atlasWorker] : null
  if (s.lc.closePhase === 'ingest' && worker && (await sessionAlive(worker)))
    await run(['tmux', 'send-keys', '-t', worker.tmux, 'Escape'])
  // Restore the session to a live lifecycle state and clear every close marker.
  const fromState = s.lc.state
  s.lc.state = mirrorState(s.shipState)
  s.lc.journal.push({ at: nowIso(), from: fromState, to: s.lc.state, fact: 'close_aborted' })
  delete s.lc.closePhase
  delete s.lc.closingAt
  delete s.lc.ingestAt
  delete s.lc.sawBusy
  delete s.lc.cleanupOnClose
  persist()
  audit({ action: 'close-abort', id, repo: s.repo, kind: s.kind === 'knowledge' ? 'knowledge' : 'dev', ok: true })
  return { status: 200, ok: true }
}

export async function output({ id, lines }) {
  const s = registry.sessions[id]
  if (!s) return { status: 404, ok: false, error: 'no such session' }
  // Make the pane tall so the transcript carries far more of the conversation
  // than the default 80x24 visible region. Wait a beat after an actual grow so
  // Claude has re-rendered into the new height before we snapshot it; subsequent
  // polls find it already tall and skip both the resize and the wait.
  if (await ensurePaneTall(s.tmux)) await sleep(150)
  const n = Math.min(Math.max(Number(lines) || 200, 1), 2000)
  return { status: 200, ok: true, id, output: collapseBlankRuns(await captureTail(s, n, true)) }
}

// Full chat history reconstructed from the agent's on-disk Claude Code `.jsonl`
// transcript(s) — the COMPLETE conversation (across resume-forked files), unlike
// output() which only captures the live tmux pane. See agent-history.mjs for the
// stitch strategy (enumerate the 1:1 worktree dir; pinned file for shared vaults).
export async function history({ id, rev }) {
  const s = registry.sessions[id]
  if (!s) return { status: 404, ok: false, error: 'no such session' }
  try {
    const data = readHistory({ worktree: s.worktree, sessionId: s.claudeSessionId, kind: s.kind, steered: s.steered })
    // Cheap live-poll path: the caller echoes the rev it last saw; when nothing
    // changed on disk, skip re-serializing the (potentially large) payload.
    if (rev && data.rev && rev === data.rev) return { status: 200, ok: true, id, unchanged: true, rev: data.rev }
    return { status: 200, ok: true, id, ...data }
  } catch (e) {
    return { status: 500, ok: false, error: String(e?.message || e) }
  }
}

// Aggregate agent time-tracking history for the Scorecard's "Agent work" group
// (see agent-timings.mjs). Read-only roll-up of the timings log.
export function agentStats() {
  return aggregate()
}
