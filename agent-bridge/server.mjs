#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * Atlas Kit agent-bridge — drive Claude Code sessions in local dev
 * containers (see docs/SETUP.md).
 *
 * Runs HOST-NATIVE on the workstation (it holds docker access ≈ root) and
 * is reached by the Hetzner box over the Tailscale tailnet. The dashboard
 * proxies to it with the bridge bearer injected server-side. Dev containers
 * run UNCHANGED — the bridge shells `docker exec <container>` to drive their
 * tmux + git + claude.
 *
 * Each spawned agent gets its own `git worktree` on a fresh `agent/<id>`
 * branch (isolated working dir, shared .git) so parallel agents in one repo
 * don't stomp each other. You review/merge the branch; kill leaves the
 * worktree/branch in place.
 *
 * Contract (bearer-protected, bind tailnet-only):
 *   GET  /health
 *   GET  /sessions               → { generated, sessions:[...] }
 *   GET  /output?id=&lines=      → { id, output }
 *   GET  /download?id=&name=     → raw bytes of a file the agent offered
 *   POST /spawn   { task, repo, preamble?, model?, effort?, images? }  → { ok, id }
 *   POST /prompt  { id, text, images? }  → { ok }   (images: data-URL uploads)
 *   POST /kill    { id }          → { ok }
 *   POST /redeploy                → { ok, started }  pull this checkout + restart
 *                                  this bridge's own service (the dashboard's
 *                                  "Redeploy bridge" button)
 *   GET  /redeploy-status         → { ok, redeploy }  its phase state file
 *   POST /outbox  { verdicts? }   → { messages }  agent↔agent mail (and Atlas
 *                                  queries) waiting for the box — see the
 *                                  message channel below
 *   POST /api/agents/message { to, text }  → { ok }  a CONTAINER agent's send,
 *                                  authed by its own per-session scoped token —
 *                                  one of the two routes not on the bridge bearer
 *   POST /api/atlas/query { tool, args }   → { ok, result }  a CONTAINER agent's
 *                                  READ-ONLY Atlas query, same scoped-token auth
 *                                  and the same park-and-drain relay as mail
 *   ALL  /agent-app/<repo>/…     → reverse-proxy (HTTP + WebSocket) to the live
 *                                  app the agent runs in its container, reached
 *                                  via that container's already-published port
 *
 * Dependency-free (node: builtins only) so host install is `git clone` +
 * the systemd unit — no npm install on the workstation.
 *
 * SECURITY: this is the highest-trust surface in the system. Defenses:
 *  - bearer on EVERY request (timing-safe); refuse to start without a token
 *  - bind tailnet-only (BRIDGE_HOST = the tailscale IP) + a Tailscale ACL
 *  - spawn targets are an ALLOWLIST (repos.json) — never an arbitrary
 *    container/path from the client; the client sends a repo KEY
 *  - task → strict slug; no user string ever reaches a host shell unescaped
 *    (docker/git/tmux are execFile arg-arrays; the one shell hop — the launch
 *    command — has the task single-quoted)
 *  - append-only audit log of every spawn/prompt/kill
 * ------------------------------------------------------------------ */
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFile, execFileSync, spawn as spawnProcess } from 'node:child_process'
// Transcript parsing shared with the box-local executor (agent-local.mjs). Pure
// node-builtins module, so importing it across the sibling api/ dir keeps the
// bridge install dependency-free (git clone has api/ alongside; no npm). The box
// reads its agents' transcripts off its own disk; here we feed these the same
// collectors over a transcript read out of the CONTAINER (readContainerTranscript).
import {
  projectKey, scanContextTokens, scanShipMarker,
  collectSubAgents, mergeSubAgentLog,
  collectBackgroundJobs, mergeBackgroundJobLog,
} from '../api/src/subagent-scan.mjs'
import { parseTranscript, stitchParsed, steerKey, steerEntry, tagSteered } from '../api/src/agent-history.mjs'
import { parseChoiceMenu, currentHighlight, driveSelect } from '../api/src/menu.mjs'
// The queued-prompt delivery gate, shared with the box-local executor so the two
// cannot drift: one per-kind classification, one menu/pacing rule, one test.
import { selectDelivery, deliveryBackoffMs, deliveryText } from '../api/src/queue-delivery.mjs'
// A launch prompt travels by FILE, never inside the tmux command — the same
// shell shape the box-local executor builds, so the two cannot drift.
import { promptFileBody, promptFileCommand } from '../api/src/prompt-file-launch.mjs'
// Is a turn running? Two witnesses — the footer's `esc to interrupt` marker and
// the spinner line above the input box — because the footer is rendered to the
// pane width and drops that marker mid-turn. IMPORTED, not copied: the box
// executor gates delivery on the same verdict, and a bridge-local copy would
// drift (same reason decideDelivery is shared).
import { isBusy } from '../api/src/pane-busy.mjs'
import { sanitizeForTyping, deliveryLanded, clearInputBox, TUI_CLEAR_KEY, TUI_VERIFY, TUI_VERIFY_MAX_CHARS, TUI_VERIFY_SETTLE_MS, TUI_VERIFY_TRIES } from '../api/src/tui-input.mjs'
// The `agent-msg` / `atlas-query` wrapper sources — ONE copy, written into each
// container here and onto the box's PATH by agent-local.mjs, so the command an
// agent runs is identical wherever it runs.
import { MSG_WRAPPER_SRC } from '../api/src/agent-msg-wrapper.mjs'
import { ATLAS_QUERY_WRAPPER_SRC } from '../api/src/atlas-query-wrapper.mjs'
// The spawn-admission rule, shared for the third time and the most important one:
// THIS box is the authority on its own memory, and the box-side pre-flight check
// must refuse for exactly the same arithmetic (see agent-capacity.mjs).
import { capacityVerdict, capacityMessage, readMemStatus } from '../api/src/agent-capacity.mjs'
import { buildRedeploySystemdRunArgs, isUnitCollisionError } from './redeploy.mjs'

const PORT = Number(process.env.BRIDGE_PORT || 7878)
// Default to loopback: refuse to be reachable until the operator deliberately
// binds the tailnet IP (the installer sets this from `tailscale ip -4`).
const HOST = process.env.BRIDGE_HOST || '127.0.0.1'
const TOKEN = process.env.BRIDGE_TOKEN || ''
const HERE = path.dirname(new URL(import.meta.url).pathname)
// The repo root (agent-bridge/'s parent) — where scripts/restart-agent-bridge.sh
// and its own .git live, for the redeploy action + startup SHA below.
const ROOT = path.join(HERE, '..')
const REPOS_FILE = process.env.BRIDGE_REPOS || path.join(HERE, 'repos.json')
const STATE_FILE = process.env.BRIDGE_STATE || path.join(HERE, 'state.json')
const AUDIT_LOG = process.env.BRIDGE_AUDIT_LOG || path.join(HERE, 'audit.log')
// `{task}`/`{model}`/`{effort}` are substituted with shell-quoted per-spawn
// values from the dashboard; the proxy validates them and resolves the model ID
// (Opus/Fable carry the `[1m]` extended-context suffix by default; Sonnet does
// not, since its 1M variant needs usage credits — see AGENT_EXTENDED_CONTEXT in
// agent-routes.mjs). A custom AGENT_LAUNCH_CMD without the placeholders simply
// keeps whatever it hardcodes.
// ⚠️ `claude` stays a BARE name here on purpose. Unlike the box-local executor
// (which resolves an absolute path via api/src/claude-bin.mjs), this command runs
// INSIDE the dev container via `docker exec` — the bridge host's filesystem, and
// therefore any path it resolved, does not apply. The container's own PATH is the
// only correct lookup. Set AGENT_LAUNCH_CMD to pin a path inside the container.
const LAUNCH_CMD =
  process.env.AGENT_LAUNCH_CMD ||
  'IS_SANDBOX=1 claude --model {model} --effort {effort} --dangerously-skip-permissions {task}'
// Where a session's launch prompt is materialized INSIDE its container. The
// prompt is NOT interpolated into the tmux command (see prompt-file-launch.mjs):
// tmux rejects a `new-session … sh -lc <cmd>` over ~16 KB with `command too
// long`, and the retrieved Atlas evidence the box folds into an opening prompt
// is tens of KB on its own. Per-session (two concurrent spawns cannot collide)
// and under /tmp — never inside the repo or its worktree, where it would show up
// as untracked in the agent's own `git status`.
const PROMPT_DIR = process.env.BRIDGE_PROMPT_DIR || '/tmp/atlas-kit-prompts'
const promptFileFor = (id) => path.posix.join(PROMPT_DIR, `${String(id).replace(/[^A-Za-z0-9._-]/g, '_')}.txt`)
// Capabilities this bridge advertises on GET /health. The box reads them before
// it sizes a spawn's prompt: `prompt-file` says "send the whole thing, it does
// not go through the tmux command line". A bridge that has not been redeployed
// since this shipped simply doesn't list it, and the box clips to the old budget
// — which is the ONLY thing keeping a mixed-version fleet spawning, because an
// oversized prompt to an un-upgraded bridge fails the spawn SILENTLY.
const FEATURES = ['prompt-file']
// Fallback only — the proxy normally supplies the resolved model. Defaults to the
// 1M Opus variant to match the proxy's default.
const DEFAULT_MODEL = 'claude-opus-4-8[1m]'
const DEFAULT_EFFORT = 'xhigh'
const EXEC_TIMEOUT_MS = Number(process.env.BRIDGE_EXEC_TIMEOUT_MS || 15000)
// Detector window: the bottom rows of the pane the busy/menu scans look at
// (captureTail slices to this) — see agent-local.mjs's TAIL_LINES for why 32.
const TAIL_LINES = Number(process.env.BRIDGE_TAIL_LINES || 32)
// Transcript geometry — mirrors the box-local executor. Claude Code is an
// alternate-screen TUI, so its conversation never enters tmux scrollback; the
// default 80x24 pane makes capture-pane return only the last ~24 rows, which
// reads as a truncated history on reload. Growing the pane HEIGHT (width stays
// 80, the fixed transcript grid) makes Claude re-render more of its in-memory
// conversation into the visible region. Done lazily, only when output() fetches
// a transcript, so unwatched agents stay at the cheap default.
const PANE_ROWS = Number(process.env.BRIDGE_PANE_ROWS || 400)
const PANE_COLS = Number(process.env.BRIDGE_PANE_COLS || 80)
// After an interrupt we send Escape, then wait this long for Claude Code's TUI to
// stop the turn and return to an empty prompt before typing the added context.
// Queued prompts are flushed on a timer: each tick, any session gone idle (no busy
// marker, no menu) gets its pending prompt delivered — true end-of-turn delivery.
const INTERRUPT_SETTLE_MS = Number(process.env.BRIDGE_INTERRUPT_SETTLE_MS || 400)
const QUEUE_FLUSH_MS = Number(process.env.BRIDGE_QUEUE_FLUSH_MS || 3000)
// Kill-switch for mid-turn (boundary) delivery, default on. Deliberately its OWN
// `BRIDGE_*` env rather than the box's AGENT_BOUNDARY_DELIVERY: a bridge machine
// is restarted separately from the box, so the two executors must be revertible
// independently. `0` restores idle-only gating exactly.
const BOUNDARY_DELIVERY = !/^(0|false|no|off)$/i.test(process.env.BRIDGE_BOUNDARY_DELIVERY || '1')
// Verified choice-menu selection (mirrors the box-local executor's
// selectChoice): the settle delay after each nav key before re-capturing the pane.
const SELECT_STEP_MS = Number(process.env.BRIDGE_SELECT_STEP_MS || 250)
// Sanity cap on a single prompt's text, delivered as one literal tmux
// send-keys line — not a real terminal paste, so no bracketed-paste chunking.
const PROMPT_MAX_CHARS = Number(process.env.BRIDGE_PROMPT_MAX_CHARS || 50000)
// `s.queued` is a FIFO of parked prompts; cap its depth so a stuck agent that
// never flushes can't grow the persisted state without bound.
const MAX_QUEUED = Number(process.env.BRIDGE_MAX_QUEUED || 20)
/* Spawn admission on THIS box (agent-capacity.mjs). A bridge box is usually not a
 * dedicated agent host — it may also run your production stack, a CI runner and
 * per-PR preview containers — so the ceiling is deliberately lower than the
 * box-local executor's, and the memory floor is the real brake either way.
 * The box re-applies these same numbers before it even calls /spawn; they are
 * reported on /health so there is ONE place to tune them: here, on the box they
 * describe. `BRIDGE_AGENT_MEM_CHARGE_SWAP=0` is the single kill-switch for the
 * swap charge (it turns it off in BOTH layers, since the box uses what we
 * report). */
const AGENT_MAX_LIVE = Number(process.env.BRIDGE_AGENT_MAX_CONCURRENT || 8)
const AGENT_MEM_FLOOR_MB = Number(process.env.BRIDGE_AGENT_MEM_FLOOR_MB || 1200)
const AGENT_MEM_PER_AGENT_MB = Number(process.env.BRIDGE_AGENT_MEM_PER_AGENT_MB || 500)
const AGENT_MEM_CHARGE_SWAP = !/^(0|false|no|off)$/i.test(process.env.BRIDGE_AGENT_MEM_CHARGE_SWAP || '1')
// Upload limits (the /prompt path can carry attached files). The request body
// cap is raised for /prompt to fit base64 payloads (see readBody / the router).
// The `images` wire field is historical; it now carries any file type.
const MAX_IMAGES = Number(process.env.BRIDGE_MAX_IMAGES || 6)
const MAX_IMAGE_BYTES = Number(process.env.BRIDGE_MAX_IMAGE_BYTES || 8 * 1024 * 1024)
// Live-stats file an agent publishes inside its container (see STATS_PREAMBLE in
// the dashboard). The bridge cats it each /sessions poll and returns the raw
// latest {label:value}; the box accumulates the history. Cap what one session may
// publish (matches the box-local cap).
const MAX_STATS_BYTES = Number(process.env.BRIDGE_STATS_MAX_BYTES || 64 * 1024)
// Downloads dir a session can drop files into inside its container (see
// DOWNLOADS_PREAMBLE in the dashboard). Caps on what one session may offer,
// matching the box-local caps.
const MAX_DOWNLOAD_FILES = Number(process.env.BRIDGE_DOWNLOADS_MAX_FILES || 20)
const MAX_DOWNLOAD_BYTES = Number(process.env.BRIDGE_DOWNLOAD_MAX_BYTES || 100 * 1024 * 1024)
// Bytes of each session's Claude Code transcript we tail out of the container per
// poll to derive sub-agents / background jobs / context fill (mirrors the box's
// 1 MiB CONTEXT_TAIL_BYTES). Kept under dockerExec's 4 MiB maxBuffer.
const TRANSCRIPT_TAIL_BYTES = Number(process.env.BRIDGE_TRANSCRIPT_TAIL_BYTES || 1024 * 1024)
const PROMPT_BODY_LIMIT = Number(process.env.BRIDGE_PROMPT_BODY_LIMIT || 24 * 1024 * 1024)
// Live-app slots: each dev agent runs its own web app (Streamlit etc.) inside its
// container, which the box embeds beside the transcript. By default the bridge
// reaches each by the container's own IP (container-IP routing — see below); the
// published-host-port path (`docker port`) is the fallback for non-routable IPs.
// Per-repo override via repos.json `appPort`; default 8501 (Streamlit's default).
//
// MULTI-APP: each SESSION gets its own port in the band [APP_PORT, APP_PORT+APP_SPAN)
// inside its container, so one container serves many apps at once. The bridge
// reaches each by the CONTAINER'S OWN IP (container-IP routing) — on a native
// Linux bridge the host routes to e.g. 172.17.0.2:<port> directly, so nothing is
// published and parallel containers never collide. BRIDGE_APP_ROUTING=published
// forces the legacy `docker port` (published-host-port) path for environments
// where container IPs aren't host-routable (e.g. Docker Desktop's VM); 'auto'
// (default) uses container-IP when a one-time probe shows it's routable, else
// falls back to published.
const APP_PORT = Number(process.env.BRIDGE_APP_PORT || 8501)
const APP_SPAN = Number(process.env.BRIDGE_APP_SPAN || 16)
const APP_ROUTING = process.env.BRIDGE_APP_ROUTING || 'auto'
const APP_PROBE_MS = Number(process.env.BRIDGE_APP_PROBE_MS || 300)
const ROUTABLE_PROBE_MS = Number(process.env.BRIDGE_ROUTABLE_PROBE_MS || 600)
// listSessions() probes each session with several sequential docker exec/tmux/TCP
// round trips — a bounded-concurrency fan-out instead of a serial loop keeps the
// box's AGENT_BRIDGE_TIMEOUT_MS poll well under budget as the session count
// grows. Bounded (not an unbounded Promise.all) so a big fleet doesn't fork
// dozens of `docker exec` processes at once.
const LIST_CONCURRENCY = Number(process.env.BRIDGE_LIST_CONCURRENCY || 8)

// The running code's commit SHA, sampled once at startup — GET /health returns
// it so the box's redeploy poll can verify a redeploy actually picked up new
// code (not just that systemd bounced the same binary back up).
let startupSha = '?'
try {
  startupSha = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }).trim()
} catch {
  /* not a git checkout (unlikely) — health still works, just no sha */
}

/* --- tiny helpers -------------------------------------------------- */
const nowIso = () => new Date().toISOString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Run `fn` over `items` with at most `limit` in flight at once — dependency-free
// (this package is deliberately dependency-free), so no p-limit.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

// POSIX single-quote escaping — safe to embed in a `sh -lc` string.
function shquote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

// Strict slug: lowercase alnum + dashes, bounded length. The id, branch
// (agent/<id>), tmux name (agent-<id>) and worktree leaf all derive from it.
function slugify(task) {
  return String(task)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return fallback
  }
}

/* --- repo allowlist + session registry ----------------------------- */
function loadRepos() {
  const repos = readJson(REPOS_FILE, null)
  if (!repos || typeof repos !== 'object') {
    throw new Error(`repos allowlist missing/invalid: ${REPOS_FILE}`)
  }
  return repos
}

// In-memory registry, persisted to STATE_FILE so it survives a bridge restart.
let registry = readJson(STATE_FILE, { sessions: {} })
if (!registry || typeof registry !== 'object' || !registry.sessions) {
  registry = { sessions: {} }
}
// Back-compat: `s.queued` was once a single slot (one object); it's now a FIFO
// array of parked prompts. Normalize any legacy object to a one-element array.
for (const s of Object.values(registry.sessions)) {
  if (s.queued && !Array.isArray(s.queued)) s.queued = [s.queued]
}
function persist() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(registry, null, 2))
  } catch (e) {
    console.error('persist failed:', e.message)
  }
}

function audit(entry) {
  try {
    fs.appendFileSync(AUDIT_LOG, JSON.stringify({ at: nowIso(), ...entry }) + '\n')
  } catch (e) {
    console.error('audit failed:', e.message)
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

/* --- docker exec --------------------------------------------------- */
// Run `docker exec <container> <argv...>`. argv is a real arg array (no host
// shell), so container/path/branch/text are never shell-interpolated.
function dockerExec(container, argv) {
  return new Promise((resolve) => {
    execFile(
      'docker',
      ['exec', container, ...argv],
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err?.code ?? 0,
          stdout: stdout || '',
          // claude prints some failures to stdout — combine for the detail.
          stderr: (stderr || '') + (err && !stderr ? String(err.message) : ''),
        })
      },
    )
  })
}

// Like dockerExec but pipes `input` (a Buffer) to the command's stdin — used to
// stream image bytes into a file inside the container (`cp /dev/stdin <path>`,
// which produces no stdout, so big images don't blow maxBuffer).
function dockerExecInput(container, argv, input) {
  return new Promise((resolve) => {
    const child = execFile(
      'docker',
      ['exec', '-i', container, ...argv],
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: stdout || '',
          stderr: (stderr || '') + (err && !stderr ? String(err.message) : ''),
        })
      },
    )
    child.stdin.end(input)
  })
}

/* --- live-app proxy ------------------------------------------------ *
 * Reverse-proxy `/agent-app/<repo>/…` (HTTP + WebSocket) from the box to the
 * Streamlit (or any HTTP+WS server) the agent runs INSIDE its container, reached
 * via the container's already-published host port. The path is preserved so the
 * agent's `--server.baseUrlPath agent-app/<repo>` matches end-to-end. */

// `docker <argv...>` (NOT exec-into-container) → stdout string, '' on failure.
function dockerCli(argv) {
  return new Promise((resolve) => {
    execFile('docker', argv, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) =>
      resolve(err ? '' : stdout || ''),
    )
  })
}

// Fill an APP_PREAMBLE's {appAddress}/{appPort}/{appBasePath} tokens for one
// SESSION's slot: bind 0.0.0.0 (so the bridge reaches it by container IP, or via
// the published port), this session's allocated port, and the per-session base
// path `agent-app/<repo>/<id>` the proxy preserves end-to-end.
function injectApp(text, repo, id, internalPort) {
  return text
    .replaceAll('{appAddress}', '0.0.0.0')
    .replaceAll('{appPort}', String(internalPort))
    .replaceAll('{appBasePath}', `agent-app/${repo}/${id}`)
}

// Discover the HOST port a container's internal app port is published on (e.g.
// `docker port my-project-dev 8501/tcp` → "0.0.0.0:8501"). Cached — a running
// container's mapping is static. Returns 0 when the port isn't published.
const hostPortCache = new Map()
async function hostPortFor(container, internal) {
  const key = `${container}:${internal}`
  if (hostPortCache.has(key)) return hostPortCache.get(key)
  const out = await dockerCli(['port', container, `${internal}/tcp`])
  const m = /:(\d+)\s*$/m.exec(out.trim())
  const port = m ? Number(m[1]) : 0
  if (port) hostPortCache.set(key, port)
  return port
}

// '/agent-app/<repo>/<id>/rest…' → the SESSION id (2nd segment), '' if malformed.
function sessionIdOfPath(p) {
  const PREFIX = '/agent-app/'
  if (!p.startsWith(PREFIX)) return ''
  return p.slice(PREFIX.length).split('/')[1] || ''
}

// Lowest free port in this container's band [base, base+APP_SPAN). Scans LIVE
// sessions in the same container (kill/cleanup delete them, freeing the port);
// `base` is the repo's appPort (default APP_PORT). Falls back to base if the band
// is full — vanishingly unlikely for one operator.
function allocAppPort(container, base) {
  const used = new Set()
  for (const s of Object.values(registry.sessions))
    if (s.container === container && s.appPort) used.add(Number(s.appPort))
  for (let p = base; p < base + APP_SPAN; p++) if (!used.has(p)) return p
  return base
}

// The container's own IP on the Docker network (e.g. 172.17.0.2): the default-
// bridge field first, then the first user-network with an address. Cached per
// container (a recreate changes it — a bridge restart clears the cache).
const ipCache = new Map()
async function containerIp(container) {
  if (ipCache.has(container)) return ipCache.get(container)
  let ip = (await dockerCli(['inspect', '-f', '{{.NetworkSettings.IPAddress}}', container])).trim()
  if (!ip)
    ip =
      (await dockerCli(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', container]))
        .trim()
        .split(/\s+/)[0] || ''
  if (ip) ipCache.set(container, ip)
  return ip
}

// TCP connect probe → true ONLY on a successful connect (the app is serving).
// Drives the live `appUp` state. `host` lets it probe a container IP, not just
// loopback.
function probeTcp(host, port, timeout = APP_PROBE_MS) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
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

// Is a container's IP host-routable? A successful connect OR ECONNREFUSED means
// the host's TCP stack reached the IP (the app may just be down) → routable; a
// timeout / EHOSTUNREACH means it isn't (e.g. Docker Desktop's VM). Decided ONCE
// per container and cached, so 'auto' routing chooses container-IP vs published
// cheaply.
const routableCache = new Map()
function rawRoutable(host, port, timeout) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
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
    sock.once('error', (e) => finish(!!e && e.code === 'ECONNREFUSED'))
  })
}
async function ipRoutable(container, ip, port) {
  if (routableCache.has(container)) return routableCache.get(container)
  const ok = await rawRoutable(ip, port, ROUTABLE_PROBE_MS)
  routableCache.set(container, ok)
  return ok
}

// Resolve a SESSION id to its live-app upstream { host, port }, or null. Prefers
// container-IP routing (many apps per container; parallel containers never
// collide); falls back to the published host port when forced
// (BRIDGE_APP_ROUTING=published) or when the container IP isn't host-routable.
async function appTarget(id) {
  const s = id && registry.sessions[id]
  if (!s || !s.container) return null
  const port = Number(s.appPort) || APP_PORT
  if (APP_ROUTING !== 'published') {
    const ip = await containerIp(s.container)
    if (ip && (await ipRoutable(s.container, ip, port))) return { host: ip, port }
  }
  const hp = await hostPortFor(s.container, port)
  return hp ? { host: '127.0.0.1', port: hp } : null
}

// Forward an ordinary HTTP request to the container app (path preserved).
async function appProxyHttp(req, res) {
  const p = new URL(req.url, 'http://bridge').pathname
  const t = await appTarget(sessionIdOfPath(p))
  if (!t) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('no live app upstream')
  }
  const up = http.request(
    { host: t.host, port: t.port, method: req.method, path: req.url, headers: req.headers },
    (ur) => {
      res.writeHead(ur.statusCode || 502, ur.headers)
      ur.pipe(res)
    },
  )
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('app unreachable')
  })
  req.pipe(up)
}

// Forward a WebSocket upgrade to the container app (Streamlit's /_stcore/stream).
async function appProxyUpgrade(req, socket, head) {
  const p = new URL(req.url, 'http://bridge').pathname
  const t = await appTarget(sessionIdOfPath(p))
  if (!t) return socket.destroy()
  const up = http.request({ host: t.host, port: t.port, method: req.method, path: req.url, headers: req.headers })
  up.on('upgrade', (ur, upSocket, upHead) => {
    const lines = ['HTTP/1.1 101 Switching Protocols']
    for (const [k, v] of Object.entries(ur.headers)) {
      if (Array.isArray(v)) for (const vv of v) lines.push(`${k}: ${vv}`)
      else lines.push(`${k}: ${v}`)
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    if (upHead && upHead.length) socket.write(upHead)
    upSocket.pipe(socket)
    socket.pipe(upSocket)
    const close = () => {
      upSocket.destroy()
      socket.destroy()
    }
    upSocket.on('error', close)
    socket.on('error', close)
  })
  up.on('error', () => socket.destroy())
  if (head && head.length) up.write(head)
  up.end()
}

// Lowercased filename extension (no dot), or '' if none.
function fileExt(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''))
  return m ? m[1].toLowerCase() : ''
}

// Decode a base64 `data:` URL upload to { ext, buf }, or null if it's empty or
// exceeds the per-file cap. Any file type is accepted — the file is written into
// the container and the agent decides what to do with it. The data URL's declared
// MIME is ignored — types report it inconsistently across browsers — so the
// extension comes from the filename (which may be '' for an extensionless file).
function decodeUpload(name, dataUrl) {
  const m = /^data:[^,]*?;base64,([\s\S]+)$/.exec(String(dataUrl || ''))
  if (!m) return null
  const ext = fileExt(name)
  const buf = Buffer.from(m[1], 'base64')
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null
  return { ext, buf }
}

// Stream uploaded files into the container under /tmp and return their paths.
// The agent reads them by path (it runs --dangerously-skip-permissions). Throws
// on an invalid file or a failed write.
async function writeImages(container, id, images) {
  const dir = `/tmp/agent-uploads/${id}`
  await dockerExec(container, ['mkdir', '-p', dir])
  const paths = []
  for (let i = 0; i < images.length; i++) {
    const parsed = decodeUpload(images[i] && images[i].name, images[i] && images[i].dataUrl)
    if (!parsed) throw new Error(`file ${i + 1} invalid or too large`)
    const stem = slugify(String((images[i] && images[i].name) || '').replace(/\.[^.]+$/, '')) || `file-${i + 1}`
    const file = path.posix.join(dir, `${Date.now()}-${i}-${stem}${parsed.ext ? `.${parsed.ext}` : ''}`)
    const w = await dockerExecInput(container, ['cp', '/dev/stdin', file], parsed.buf)
    if (!w.ok) throw new Error(`writing file ${i + 1} failed: ${w.stderr.slice(0, 200)}`)
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

async function sessionAlive(s) {
  const r = await dockerExec(s.container, ['tmux', 'has-session', '-t', s.tmux])
  return r.ok
}

async function captureTail(s, lines, ansi = false) {
  // ansi=true adds -e to keep the pane's SGR escapes (for the transcript view,
  // so the client can render Claude Code's faint placeholder muted). The status
  // /menu capture leaves it off so menuKindOf's byte patterns stay clean.
  const r = await dockerExec(s.container, [
    'tmux',
    'capture-pane',
    '-t',
    s.tmux,
    ...(ansi ? ['-e', '-p'] : ['-p']),
    '-S',
    `-${lines}`,
  ])
  if (!r.ok) return ''
  // `-S -N` only moves the capture's START into history — the end is always the
  // BOTTOM of the visible pane, so on a pane grown tall (ensurePaneTall) the raw
  // capture is the whole conversation. Slice to the last `lines` rows so the
  // busy/menu detectors see only the input-box/footer region (past `❯ <user
  // message>` echoes higher up must not read as a menu) — see agent-local.mjs.
  const text = r.stdout.replace(/\n+$/, '')
  const rows = text.split('\n')
  return rows.length > lines ? rows.slice(-lines).join('\n') : text
}

// Grow a session's pane to the tall transcript geometry (see PANE_ROWS) so
// capture-pane returns more of the conversation. Best-effort + idempotent: only
// resizes when the height differs (no SIGWINCH churn once tall). Returns true when
// it actually grew, so output() waits a beat for Claude to re-render first.
async function ensurePaneTall(s) {
  const cur = await dockerExec(s.container, ['tmux', 'display-message', '-p', '-t', s.tmux, '#{pane_height}'])
  if (!cur.ok) return false
  if (Number(cur.stdout.trim()) === PANE_ROWS) return false
  const r = await dockerExec(s.container, ['tmux', 'resize-window', '-t', s.tmux, '-x', String(PANE_COLS), '-y', String(PANE_ROWS)])
  return r.ok
}
// Claude bottom-anchors its input box, so on a tall pane a short conversation
// leaves a big blank gap before the box; collapse blank runs to at most two so
// the transcript opens on the conversation, not empty space.
const SGR_RE = /\x1b\[[0-9;?]*[A-Za-z]/g
function collapseBlankRuns(text) {
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

// The live-stats file a session publishes inside its container. `{statsFile}` in
// the agent's preamble is substituted with this at spawn (see injectApp / spawn);
// /tmp is per-container and ephemeral, so the file is temporary by construction.
function statsFile(id) {
  return `/tmp/agent-stats/${id}.json`
}

// Read a session's live-stats file from inside its container and return the raw
// latest {label:value} object, or null when the file is absent / too big /
// unparseable. The box accumulates the per-counter history (it can't live here —
// the bridge keeps no history); this just surfaces the agent's newest numbers.
async function readContainerStats(s) {
  const r = await dockerExec(s.container, ['cat', statsFile(s.id)])
  if (!r.ok) return null // no file yet (or unreadable) → no stats this poll
  const raw = r.stdout || ''
  if (!raw || raw.length > MAX_STATS_BYTES) return null
  let obj
  try {
    obj = JSON.parse(raw)
  } catch {
    return null // malformed or caught mid-write — skip this poll, retry next
  }
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null
}

// The downloads dir a session can drop files into, inside its container.
// `{downloadsDir}` in the agent's preamble is substituted with this at spawn
// (mirrors {statsFile} above), pre-created there. Unlike the stats file (one
// flat file) this is a per-session SUBDIRECTORY, so the agent can drop several
// files without name collisions.
function downloadsDir(id) {
  return `/tmp/agent-downloads/${id}`
}

// List files in a session's downloads dir: one cheap `find` per alive session
// per /sessions poll (mirrors readContainerStats above). No history to keep —
// unlike stats there's nothing to accumulate, just the current listing, capped
// + dotfiles skipped, newest first.
async function readContainerDownloads(s) {
  const r = await dockerExec(s.container, [
    'find', downloadsDir(s.id), '-maxdepth', '1', '-type', 'f', '-printf', '%f\t%s\t%T@\n',
  ])
  if (!r.ok) return null // dir absent (no downloads yet) / unreadable
  const files = []
  for (const line of (r.stdout || '').split('\n')) {
    if (!line) continue
    const [name, sizeStr, mtimeStr] = line.split('\t')
    const size = Number(sizeStr)
    const mtime = Number(mtimeStr)
    if (!name || name.startsWith('.') || !Number.isFinite(size) || !Number.isFinite(mtime)) continue
    files.push({ name, size, mtime: Math.round(mtime * 1000) }) // %T@ is seconds → ms
  }
  files.sort((a, b) => b.mtime - a.mtime)
  return files.slice(0, MAX_DOWNLOAD_FILES)
}

// Small extension→MIME table for the download's Content-Type — a courtesy;
// Content-Disposition: attachment is what actually forces the save-as regardless
// of type. Unrecognized extensions fall back to a generic binary type.
const MIME_TYPES = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.html': 'text/html', '.htm': 'text/html',
  '.json': 'application/json', '.csv': 'text/csv', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.zip': 'application/zip',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.wav': 'audio/wav',
}
function mimeFor(name) {
  return MIME_TYPES[path.posix.extname(name).toLowerCase()] || 'application/octet-stream'
}

// Stream a file out of a session's downloads dir, binary-safe. dockerExec/
// dockerExecInput above run through execFile's default utf8 string decoding of
// stdout (fine for the small JSON/text payloads they carry) — that would CORRUPT
// arbitrary binary downloads (PDFs, images, …), so this spawns `docker exec … cat`
// directly and pipes its raw stdout, never buffering or decoding it as a string.
// `name` is the already URL-decoded query value (URLSearchParams decodes once —
// decoding again would double-decode and mangle a literal `%`); it must be a
// plain basename that appears in the CURRENT capped listing.
async function streamDownload(res, id, name) {
  const s = registry.sessions[id]
  if (!s) return send(res, 404, { ok: false, error: 'no such session' })
  if (!name || name === '.' || name === '..' || name !== path.posix.basename(name))
    return send(res, 400, { ok: false, error: 'invalid name' })
  const files = await readContainerDownloads(s)
  const file = files && files.find((f) => f.name === name)
  if (!file) return send(res, 404, { ok: false, error: 'no such download' })
  if (file.size > MAX_DOWNLOAD_BYTES) return send(res, 413, { ok: false, error: 'file too large' })
  res.writeHead(200, {
    'Content-Type': mimeFor(name),
    'Content-Length': String(file.size),
    'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
    'Cache-Control': 'no-store',
  })
  const child = spawnProcess('docker', ['exec', s.container, 'cat', path.posix.join(downloadsDir(id), name)], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  child.on('error', () => res.end())
  child.stdout.on('error', () => res.end())
  child.stdout.pipe(res)
}

// Read a session's newest Claude Code transcript from INSIDE its container and
// derive the same fields the box-local executor scans off its own disk:
// context-window fill, the sub-agents it spawned (Task/Agent), and the
// background jobs it launched (Bash run_in_background). Claude stores transcripts
// at $HOME/.claude/projects/<cwd-with-non-alnum-as-dash>/<session-id>.jsonl; dev
// agents don't pin a session id, so (like the box) we take the newest .jsonl in
// the worktree's project dir. ONE exec per poll (resolve $HOME, newest, tail) to
// stay within the box's 4 s /sessions budget. Best-effort: any miss (no
// transcript yet, unreadable) → null, and the card simply omits those fields.
//
// NOTE: only the MAIN transcript is scanned. Jobs launched BY a sub-agent (which
// live in the sub-agent's own transcript) aren't attributed here yet — the
// box-local executor's subAgentJobSnaps is the box-only refinement; directly-
// launched jobs (the common case) are covered.
async function readContainerTranscript(s) {
  if (!s.worktree) return null
  // projectKey output is alnum+dash only (every non-alnum → '-'), so it's safe
  // to interpolate into the double-quoted path; the byte count is a number.
  const key = projectKey(s.worktree)
  const cmd =
    `d="$HOME/.claude/projects/${key}"; ` +
    `f=$(ls -t "$d"/*.jsonl 2>/dev/null | head -n1); ` +
    `[ -n "$f" ] && tail -c ${TRANSCRIPT_TAIL_BYTES} "$f"`
  const r = await dockerExec(s.container, ['sh', '-lc', cmd])
  if (!r.ok || !r.stdout) return null
  const lines = r.stdout.split('\n')
  return {
    tokens: scanContextTokens(lines),
    sub: collectSubAgents(lines),
    jobs: collectBackgroundJobs(lines),
    ship: scanShipMarker(lines),
  }
}

// Fold a container-transcript scan into the session's STICKY logs (persisted in
// the registry, like the box-local executor) so finished sub-agents stay visible
// and a background job holds 'running' until its completion notification flips it.
// Returns whether anything changed (to gate persistence).
function mergeTranscript(s, tr) {
  if (!tr) return false
  let changed = false
  if (mergeSubAgentLog(s.subAgents || (s.subAgents = []), tr.sub)) changed = true
  if (mergeBackgroundJobLog(s.bgJobs || (s.bgJobs = []), tr.jobs)) changed = true
  if (tr.tokens > 0 && s.contextTokens !== tr.tokens) {
    s.contextTokens = tr.tokens
    changed = true
  }
  // Sticky ship state (like the box-local executor): keep the last marker seen
  // even after it scrolls out of the tail; only a NEWER marker replaces it.
  if (tr.ship && (s.shipState !== tr.ship.state || (s.shipInfo || '') !== tr.ship.info)) {
    s.shipState = tr.ship.state
    s.shipInfo = tr.ship.info
    changed = true
  }
  return changed
}

// Context window for a session's model — the `[1m]` extended-context suffix
// (Opus/Fable by default; see agent-routes.mjs) means 1M, else the 200k default.
function contextWindowFor(s) {
  return /\[1m\]/i.test(s.model || '') ? 1000000 : 200000
}

// The card-facing shape of a session.
function publicView(s, status, lastOutput, menuKind, appUp, stats, menuChoice, downloads) {
  return {
    id: s.id,
    task: s.task,
    repo: s.repo,
    branch: s.branch,
    status,
    lastOutput: lastOutput ?? '',
    menu: !!menuKind,
    menuKind: menuKind || null,
    // Parsed numbered options of a pending choice menu (+ which one the TUI's
    // `❯` sits on), so the chat view can offer them as clickable buttons, plus
    // the prompt text above them so the operator sees WHAT they're answering.
    // …question/header/per-option `description`, and an `escape` flag on the
    // TUI's own "Type something."/"Chat about this" rows, all read straight off
    // the pane (menu.mjs's parseChoiceMenu). A menu this flow can't drive
    // reliably (multi-question/multiSelect) sends no options at all, just
    // `menuUnsupported` — the card falls back to "use the terminal view".
    ...(menuChoice
      ? menuChoice.unsupported
        ? {
            menuUnsupported: true,
            menuUnsupportedReason: menuChoice.reason,
            ...(menuChoice.question ? { menuQuestion: menuChoice.question } : {}),
            ...(menuChoice.header ? { menuHeader: menuChoice.header } : {}),
          }
        : {
            menuOptions: menuChoice.options,
            menuHighlighted: menuChoice.highlighted,
            ...(menuChoice.question ? { menuQuestion: menuChoice.question } : {}),
            ...(menuChoice.header ? { menuHeader: menuChoice.header } : {}),
          }
      : {}),
    startedAt: s.startedAt,
    // Spawn-time picks (resolved model ID + effort level) — the card shows them
    // as a small label by the context meter. Absent on pre-field sessions.
    ...(s.model ? { model: s.model } : {}),
    ...(s.effort ? { effort: s.effort } : {}),
    // Prompts waiting to be delivered when this session next goes idle, in FIFO
    // order (the card shows each as a cancellable chip). Only text + image count
    // are surfaced.
    ...(Array.isArray(s.queued) && s.queued.length
      ? { queued: s.queued.map((q) => ({ text: q.text || '', images: (q.paths || []).length })) }
      : {}),
    // Live-app slot: the per-session path the dashboard embeds this agent's app
    // at, the session's allocated container port (so the card can tell the
    // operator exactly where the app must bind when nothing is serving), and
    // whether its port is currently serving (`appUp` — a TCP probe of the
    // session's container-IP:port, or the published host port; pane shows only up).
    appPath: `/agent-app/${s.repo}/${s.id}/`,
    ...(s.appPort ? { appPort: s.appPort } : {}),
    ...(appUp != null ? { appUp } : {}),
    // Transcript-derived (readContainerTranscript): the context-window fill, the
    // sub-agents this agent spawned (Task/Agent), and the background jobs it
    // launched (Bash run_in_background) — the same fields the box-local executor
    // emits, so the card's context meter + constellation leaves light up for
    // workstation agents too. No `micro` tags (those need the box's haiku pass) —
    // the card falls back to the full label.
    ...(s.contextTokens != null
      ? { contextTokens: s.contextTokens, contextWindow: contextWindowFor(s) }
      : {}),
    ...(s.subAgents && s.subAgents.length
      ? { subAgents: s.subAgents.map((e) => ({ label: e.label, active: !e.done })) }
      : {}),
    ...(s.bgJobs && s.bgJobs.length
      ? {
          // `sub` (a job spawned by a sub-agent) goes out as the owner's INDEX in
          // the subAgents array above; the bridge only scans the main transcript
          // so it's always absent here, but mirror the box's shape for the client.
          bgJobs: s.bgJobs.map((e) => {
            const sub = e.sub ? (s.subAgents || []).findIndex((a) => a.id === e.sub) : -1
            return { label: e.label, status: e.status, ...(sub >= 0 ? { sub } : {}) }
          }),
        }
      : {}),
    // Raw latest live-stats the agent published in its container (readContainerStats);
    // the box accumulates each counter's history and builds the card's mini-plots.
    ...(stats ? { stats } : {}),
    // Files the agent has offered for download (readContainerDownloads above):
    // capped, dotfiles skipped, newest first. Absent/empty → no chip on the card.
    ...(downloads && downloads.length ? { downloads } : {}),
    // Agent-signaled ship state (ATLAS:READY-TO-SHIP / ATLAS:SHIPPED markers,
    // scanned sticky off the container transcript) — so a workstation dev agent's
    // card lights the same ready ⤴ / shipped ✓ iconography as a box-local one.
    ...(s.shipState ? { shipState: s.shipState, ...(s.shipInfo ? { shipInfo: s.shipInfo } : {}) } : {}),
    // Tmux vanished out from under a still-registered session (host/container
    // restart, kill-server) — the card renders this as "lost", not "done".
    ...(s.interrupted ? { interrupted: true } : {}),
  }
}

/* --- spawn capacity ------------------------------------------------- *
 * This box's own answer to "is there room for another agent here?", reported on
 * /health (the channel the box already polls) and enforced in spawn() below.
 *
 * The live count comes from the REGISTRY, not from a probe: a docker exec per
 * session is exactly what a saturated box cannot afford, and the /sessions poll
 * already refreshes these statuses every few seconds. It therefore rounds UP (a
 * session that just died still counts until the next poll), which is the safe
 * direction for an admission gate.
 * ------------------------------------------------------------------ */
function liveSessionCount() {
  return Object.values(registry.sessions).filter((s) => s.status !== 'done' && s.status !== 'error').length
}
function agentCapacity() {
  return capacityVerdict({
    live: liveSessionCount(),
    maxAgents: AGENT_MAX_LIVE,
    mem: readMemStatus(),
    floorMb: AGENT_MEM_FLOOR_MB,
    perAgentMb: AGENT_MEM_PER_AGENT_MB,
    chargeSwap: AGENT_MEM_CHARGE_SWAP,
  })
}

/* --- endpoint handlers --------------------------------------------- */
// Each session needs several sequential docker exec/tmux/TCP round trips
// (sessionAlive, captureTail, readContainerTranscript, readContainerStats,
// readContainerDownloads, appUpFor) — O(sessions) serially crossed the box's
// AGENT_BRIDGE_TIMEOUT_MS poll budget once the fleet grew past ~10 agents.
// mapLimit runs sessions concurrently (bounded — see LIST_CONCURRENCY) so wall
// time is ~one session's chain per batch, not the sum of all of them. Each
// session only touches its OWN registry entry, so concurrent mutation of
// `changed` (a plain bool) and per-session fields is safe — JS never interleaves
// the synchronous stretches between awaits.
async function listSessions() {
  let changed = false
  // Probe each SESSION's own live-app port (per-session now, not per-repo).
  const appUpFor = async (id) => {
    const t = await appTarget(id)
    return t ? await probeTcp(t.host, t.port) : false
  }
  const out = await mapLimit(Object.values(registry.sessions), LIST_CONCURRENCY, async (s) => {
    if (s.status === 'error') {
      return publicView(s, 'error', s.error || 'spawn failed', null, await appUpFor(s.id))
    }
    const alive = await sessionAlive(s)
    // One pane capture serves both the status (is it still working?) and the tail.
    const pane = alive ? await captureTail(s, TAIL_LINES) : ''
    const status = alive ? (isBusy(pane) ? 'running' : 'idle') : 'done'
    // A session still in the registry whose tmux is gone was torn down out from
    // under it (a host/container restart, a `tmux kill-server`) — an intentional
    // kill/cleanup deletes the registry entry instead, so it never reaches here.
    // Flag it so the card shows "lost", not an indistinguishable "done". Sticky +
    // persisted, so it survives a bridge restart that reloads this as 'done'.
    if (status === 'done' && !s.interrupted) {
      s.interrupted = true
      changed = true
    }
    if (s.status !== status) {
      s.status = status
      changed = true
    }
    const tail = alive ? lastLine(pane) : s.lastSeen || ''
    if (alive && tail) {
      s.lastSeen = tail
      changed = true
    }
    const menuKind = status === 'idle' ? menuKindOf(pane) : null
    // A choice menu's numbered options, parsed from the same bottom-window pane
    // (the messenger's tested parser) — the chat view renders them as buttons.
    const menuChoice = menuKind === 'choice' ? parseChoiceMenu(pane) : null
    // Surface the agent's live stats (only while alive — a dead/lost session has
    // nothing to publish, and its /tmp file may be gone with the container).
    const stats = alive ? await readContainerStats(s) : null
    // Same for its downloads listing.
    const downloads = alive ? await readContainerDownloads(s) : null
    // Scan the container transcript for sub-agents / background jobs / context
    // fill (sticky logs persisted on the session). Only while alive — a dead
    // session has nothing new, and its transcript may be gone with the container.
    if (alive && mergeTranscript(s, await readContainerTranscript(s))) changed = true
    return publicView(s, status, tail || s.lastSeen || '', menuKind, await appUpFor(s.id), stats, menuChoice, downloads)
  })
  if (changed) persist()
  // newest first
  out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
  return out
}

function lastLine(text) {
  const lines = String(text)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length)
  return lines.length ? lines[lines.length - 1] : ''
}

// `isBusy` is imported from ../api/src/pane-busy.mjs — two witnesses (the
// footer's `esc to interrupt` marker and the spinner line above the input box),
// one implementation shared with the box executor. A bridge-local copy is
// exactly the drift that once left a bridge on the old rule after a box deploy.

// Two interactive states the respond toolbar can drive — reported as `menuKind`
// so the card shows only the confirm button that fits (and nothing when merely
// idle-at-the-prompt, where Enter/Escape do nothing):
//   • 'choice' — numbered menus (permission/plan/trust): the highlighted option
//     is marked `❯` + a REGULAR space + the option NUMBER (`❯ 1. Yes`) —
//     confirm with Enter. The number is load-bearing: Claude Code ALSO echoes
//     every past user message as `❯ <text>` with a regular space, so a bare
//     `❯ ` match reads any conversation tail as a phantom menu (see
//     agent-local.mjs — the 2026-07-01 "ship hangs" bug).
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
function menuKindOf(pane) {
  if (COMPLETE_MARKER.test(pane)) return 'complete'
  if (MENU_MARKER.test(pane)) return 'choice'
  return null
}

/* --- agent↔agent message channel (the remote half) ------------------- *
 * A container agent sends mail exactly like a box-local one — same `agent-msg`
 * wrapper (one shared source), same per-session scoped token, same
 * `/api/agents/message` path. What differs is only WHERE the wrapper posts:
 * the box's API is bound to loopback on the box and is unreachable from here, so
 * the container posts to THIS bridge, which parks the attempt and hands it to the
 * box over the SAME box→bridge channel everything else uses (the box drains
 * `POST /outbox` on its existing remote poll and posts the verdict back).
 *
 * The box is the only place that decides: lineage, the per-pair budget, the
 * attribution header and the bus log all stay there, unchanged and identical for
 * remote senders. The bridge only asserts WHO sent it — resolved from the
 * session's own token, never from the request body — which is exactly the
 * authority it already has over its sessions.
 *
 * The request BLOCKS until that verdict comes back (a few seconds; the box polls
 * every 3 s), so a rejection is a real error the sending agent reads, not a
 * silent drop. On timeout it returns "handed over, verdict unknown" rather than
 * claiming success.
 *
 * Deliberately in-memory: a bridge restart drops at most the handful of
 * in-flight attempts, and nothing here is worth a persist() on every attempt.
 * Session tokens DO persist — they ride the session record, which spawn()
 * already persists.
 *
 * A container agent's READ-ONLY Atlas query (`atlas-query`, atlasQuery below)
 * rides the SAME channel — same scoped token, same park-and-drain, same
 * blocking verdict — because it has the same problem. Its policy likewise lives
 * on the box (api/src/atlas-query-relay.mjs).
 * ------------------------------------------------------------------ */
const MSG_BIN_DIR = process.env.BRIDGE_MSG_BIN_DIR || '/tmp/atlas-kit-bin'
const MSG_WRAPPER = path.posix.join(MSG_BIN_DIR, 'agent-msg')
const ATLAS_WRAPPER = path.posix.join(MSG_BIN_DIR, 'atlas-query')
// Where a CONTAINER reaches this bridge. The bind address is the host's own
// network IP (install-agent-bridge.sh), which a container reaches through its
// default gateway = the host — the same host-routability the live-app proxy
// relies on in the other direction. Override for setups where it isn't.
const MSG_API = process.env.BRIDGE_MSG_API || `http://${HOST}:${PORT}`
// How long a sending agent waits for the box's verdict before being told the
// message was handed over but the outcome is unknown.
const MSG_VERDICT_MS = Number(process.env.BRIDGE_MSG_VERDICT_MS || 20000)
// Hard cap on parked attempts — a box that stops draining must not grow this
// without bound. Oldest first, so the cap sheds the ones already timing out.
const MSG_OUTBOX_MAX = Number(process.env.BRIDGE_MSG_OUTBOX_MAX || 50)
const MSG_TEXT_MAX = Number(process.env.BRIDGE_MSG_TEXT_MAX || 20000)

// Write the shared wrapper into the container (idempotent; cheap enough to redo
// per spawn). Best-effort: a container without node just fails to run it, which
// the agent sees as a plain command error.
async function writeMsgWrapper(container) {
  await dockerExec(container, ['mkdir', '-p', MSG_BIN_DIR])
  const w = await dockerExecInput(container, ['sh', '-c', `cat > ${MSG_WRAPPER} && chmod 755 ${MSG_WRAPPER}`], Buffer.from(MSG_WRAPPER_SRC))
  if (!w.ok) console.error('[bridge] agent-msg wrapper write failed:', w.stderr.slice(0, 200))
}

// Same for `atlas-query` — the Atlas READ query relay (atlasQuery below). Its
// absence is exactly how an un-restarted bridge degrades: the command simply
// isn't there, which the agent reads as a plain "not found" and works around.
async function writeAtlasWrapper(container) {
  await dockerExec(container, ['mkdir', '-p', MSG_BIN_DIR])
  const w = await dockerExecInput(container, ['sh', '-c', `cat > ${ATLAS_WRAPPER} && chmod 755 ${ATLAS_WRAPPER}`], Buffer.from(ATLAS_QUERY_WRAPPER_SRC))
  if (!w.ok) console.error('[bridge] atlas-query wrapper write failed:', w.stderr.slice(0, 200))
}

// Env assignments prefixed onto a session's launch command — its own id, its
// scoped token, this bridge's message endpoint, the wrapper on PATH. Mirrors
// agent-local.mjs's msgEnv; empty for sessions with no token (pre-field ones).
function msgEnv(s) {
  if (!s.msgToken) return ''
  return `ATLAS_AGENT_ID=${shquote(s.id)} ATLAS_AGENT_TOKEN=${shquote(s.msgToken)} ATLAS_API=${shquote(MSG_API)} PATH=${shquote(MSG_BIN_DIR)}:$PATH `
}

// Resolve a scoped token to its session id. Only ever matches a session still in
// the registry — which IS the revocation mechanism (mirrors agentByToken box-side).
function agentIdByToken(token) {
  if (!token || typeof token !== 'string') return ''
  for (const s of Object.values(registry.sessions)) {
    if (s.msgToken && timingSafeEqual(s.msgToken, token)) return s.id
  }
  return ''
}

let msgSeq = 0
const outbox = [] // [{ seq, kind?, from, … }] — parked, waiting for the box
const msgPending = new Map() // seq -> resolve(verdict)

/* Park one attempt for the box and BLOCK on its verdict — shared by mail and
 * Atlas queries, which ride the same relay. `timeoutNote` is what the caller is
 * told if no verdict arrives in time (never a claim of success). */
function parkForBox(item, timeoutNote) {
  const seq = ++msgSeq
  outbox.push({ seq, ...item, at: nowIso() })
  while (outbox.length > MSG_OUTBOX_MAX) {
    const dropped = outbox.shift()
    const r = msgPending.get(dropped.seq)
    if (r) {
      msgPending.delete(dropped.seq)
      r({ status: 503, ok: false, error: 'the dashboard is not draining this bridge — dropped' })
    }
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      msgPending.delete(seq)
      resolve({ status: 202, ok: true, note: timeoutNote })
    }, MSG_VERDICT_MS)
    msgPending.set(seq, (verdict) => {
      clearTimeout(timer)
      resolve(verdict)
    })
  })
}

// A container agent's send. Authed by ITS OWN scoped token (not the bridge
// bearer), so this route is handled before the bridge-token gate.
async function agentMessage(body, token) {
  const from = agentIdByToken(token)
  if (!from) return { status: 401, ok: false, error: 'unauthorized (use your own $ATLAS_AGENT_TOKEN)' }
  const { to, text } = body || {}
  if (!to || typeof to !== 'string') return { status: 400, ok: false, error: 'missing "to"' }
  if (typeof text !== 'string' || !text.trim()) return { status: 400, ok: false, error: 'missing "text"' }
  if (text.length > MSG_TEXT_MAX) return { status: 400, ok: false, error: `text too long (max ${MSG_TEXT_MAX} chars)` }
  audit({ action: 'agent-message', id: from, to, len: text.length, ok: true })
  return await parkForBox({ from, to, text }, `handed to the dashboard for ${to} — no verdict yet`)
}

/* A container agent's READ-ONLY Atlas query, on the same channel and the same
 * scoped-token auth as mail: parked here, drained by the box on its remote poll,
 * run there against the knowledge-only tool surface, answer pushed back as the
 * verdict. The bridge decides NOTHING about it — the allowlist of reachable
 * tools, the per-session budget, the result cap and the query log all live on
 * the box (api/src/atlas-query-relay.mjs), exactly as the bus's policy does.
 *
 * Blocks until that answer arrives, because a query the agent has to poll for
 * costs a model turn per poll — more than the query saves. */
async function atlasQuery(body, token) {
  const from = agentIdByToken(token)
  if (!from) return { status: 401, ok: false, error: 'unauthorized (use your own $ATLAS_AGENT_TOKEN)' }
  const { tool, args } = body || {}
  if (!tool || typeof tool !== 'string') return { status: 400, ok: false, error: 'missing "tool"' }
  if (args != null && (typeof args !== 'object' || Array.isArray(args))) return { status: 400, ok: false, error: '"args" must be a JSON object' }
  audit({ action: 'atlas-query', id: from, tool, ok: true })
  return await parkForBox(
    { kind: 'atlas-query', from, tool, args: args || {} },
    'no answer yet — the dashboard is down, or has not started draining this bridge again; try once more',
  )
}

/* The box's half of that hand-off, on the bridge-bearer channel: it posts the
 * verdicts for the batch it drained last, and takes whatever has been parked
 * since. Draining is destructive — the box owns each message once it has it. */
function takeOutbox({ verdicts } = {}) {
  for (const v of Array.isArray(verdicts) ? verdicts : []) {
    const resolve = msgPending.get(v?.seq)
    if (!resolve) continue // already timed out — the agent has been told
    msgPending.delete(v.seq)
    resolve({
      status: Number(v.status) || 200,
      ok: v.ok !== false,
      ...(v.error ? { error: v.error } : {}),
      ...(v.note ? { note: v.note } : {}),
      // An Atlas query's answer (atlasQuery above) — the one verdict that
      // carries a payload rather than just an outcome.
      ...(typeof v.result === 'string' ? { result: v.result } : {}),
      ...(v.truncated ? { truncated: true } : {}),
    })
  }
  const messages = outbox.splice(0, outbox.length)
  return { status: 200, ok: true, messages }
}

async function spawn({ task, repo, preamble, model, effort, images }) {
  if (!task || typeof task !== 'string') return { status: 400, ok: false, error: 'task required' }
  if (!repo || typeof repo !== 'string') return { status: 400, ok: false, error: 'repo required' }

  const repos = loadRepos()
  const target = repos[repo]
  if (!target) return { status: 400, ok: false, error: `unknown repo "${repo}"` }

  // This box's own brake, checked before anything is created. The box runs the
  // same check on what /health reported, but it is the caller: its reading can be
  // seconds stale, an OLD box side reports nothing at all, and a direct call to
  // this bridge bypasses it entirely. We are the authority on our own memory.
  const cap = agentCapacity()
  if (!cap.ok) {
    const error = capacityMessage('this bridge box', cap)
    audit({ action: 'spawn', repo, ok: false, error, capacity: cap })
    console.error(`[spawn] refused: ${error}`)
    return { status: 503, ok: false, error, capacity: cap }
  }

  const base = slugify(task)
  if (!base) return { status: 400, ok: false, error: 'task has no usable slug' }
  // Guarantee a unique id even if the same task is spawned twice.
  let id = base
  for (let n = 2; registry.sessions[id]; n++) id = `${base}-${n}`

  const branch = `agent/${id}`
  const tmux = `agent-${id}`
  // Default worktrees INSIDE the repo dir: the repo is typically owned by the
  // dev user and writable, whereas its parent (e.g. /workspace) is often
  // root-owned. Override per-repo with `worktreeBase` for a different layout.
  const worktreeBase = target.worktreeBase || path.join(target.path, '.agent-worktrees')
  const worktree = path.posix.join(worktreeBase, id)
  const container = target.container
  // Per-session live-app port from this container's band (the agent binds it;
  // the bridge reaches it by container IP, or the published mapping). Allocated
  // before the worktree so injectApp can hand it to the agent.
  const appPort = allocAppPort(container, Number(target.appPort) || APP_PORT)

  const session = {
    id,
    task,
    repo,
    branch,
    container,
    path: target.path,
    worktree,
    tmux,
    appPort,
    model: model || DEFAULT_MODEL,
    effort: effort || DEFAULT_EFFORT,
    // Scoped agent↔agent message token (see the message-channel block above).
    // Persisted with the session, so it survives a bridge restart; never in
    // publicView (that's a whitelist) so it stays inside this host.
    msgToken: crypto.randomBytes(24).toString('hex'),
    status: 'running',
    startedAt: nowIso(),
  }

  // Stream any attached files into the container BEFORE creating the worktree (a
  // bad attachment fails fast, with no orphan worktree); their paths fold into the
  // opening task below so the agent can Read them on its first turn.
  let imagePaths = []
  if (Array.isArray(images) && images.length) {
    try {
      imagePaths = await writeImages(container, id, images)
    } catch (e) {
      return { status: 400, ok: false, error: e.message }
    }
  }

  // 1. worktree base dir, 2. fresh worktree on a new branch. Also pre-create the
  // live-stats dir so a bare `>` redirect to {statsFile} from the agent just
  // works, and this session's downloads dir ({downloadsDir}) so a `cp`/redirect
  // there works too.
  await dockerExec(container, ['mkdir', '-p', worktreeBase])
  await dockerExec(container, ['mkdir', '-p', '/tmp/agent-stats'])
  await dockerExec(container, ['mkdir', '-p', downloadsDir(id)])
  const wt = await dockerExec(container, [
    'git', '-C', target.path, 'worktree', 'add', '-b', branch, worktree,
  ])
  if (!wt.ok) {
    session.status = 'error'
    session.error = (wt.stderr || 'git worktree add failed').slice(0, 500)
    registry.sessions[id] = session
    persist()
    audit({ action: 'spawn', id, repo, ok: false, error: session.error })
    return { status: 502, ok: false, error: session.error }
  }

  // 3. tmux session running the launch command inside the worktree. The slug/
  // branch derive from `task` only; an optional `preamble` (standing instructions
  // from the proxy, e.g. the reconcile protocol) is appended to the prompt the
  // agent receives — so branch names stay clean.
  // {appAddress}/{appPort}/{appBasePath} in the preamble become this SESSION's
  // concrete values (0.0.0.0, its allocated port, the per-session base path), and
  // {statsFile}/{downloadsDir} its container-side live-stats/downloads paths
  // (mirrors the box-local executor).
  const prompt = preamble
    ? `${injectApp(preamble.replaceAll('{statsFile}', statsFile(id)).replaceAll('{downloadsDir}', downloadsDir(id)).replaceAll('{worktree}', worktree), repo, id, appPort)}\n\n---\n# Your task\n${withImages(task, imagePaths)}`
    : withImages(task, imagePaths)
  // The prompt travels by FILE, not inside the tmux command — written into the
  // container with `cat` over stdin, then read back by the session's own shell
  // (promptFileCommand). A write that fails must FAIL THE SPAWN: launching anyway
  // would start an unbriefed agent, which is the failure mode this whole path
  // exists to end.
  const promptPath = promptFileFor(id)
  await dockerExec(container, ['mkdir', '-p', PROMPT_DIR])
  const pw = await dockerExecInput(container, ['sh', '-c', `cat > ${shquote(promptPath)}`], Buffer.from(promptFileBody(prompt)))
  if (!pw.ok) {
    session.status = 'error'
    session.error = (pw.stderr || 'prompt file write failed').slice(0, 500)
    registry.sessions[id] = session
    persist()
    audit({ action: 'spawn', id, repo, ok: false, error: session.error })
    return { status: 502, ok: false, error: session.error }
  }
  await writeMsgWrapper(container) // `agent-msg` on the agent's PATH (message channel above)
  await writeAtlasWrapper(container) // `atlas-query` too — same PATH, same relay
  const launch = promptFileCommand(
    msgEnv(session) +
      LAUNCH_CMD
        .replace('{model}', shquote(model || DEFAULT_MODEL))
        .replace('{effort}', shquote(effort || DEFAULT_EFFORT)),
    promptPath,
  )
  const ns = await dockerExec(container, [
    'tmux', 'new-session', '-d', '-s', tmux, '-c', worktree, 'sh', '-lc', launch,
  ])
  if (!ns.ok) {
    await dockerExec(container, ['rm', '-f', promptPath]) // the session's shell never ran, so it never removed it
    session.status = 'error'
    session.error = (ns.stderr || 'tmux new-session failed').slice(0, 500)
    registry.sessions[id] = session
    persist()
    audit({ action: 'spawn', id, repo, ok: false, error: session.error })
    return { status: 502, ok: false, error: session.error }
  }

  registry.sessions[id] = session
  persist()
  audit({ action: 'spawn', id, repo, branch, container, model: model || DEFAULT_MODEL, effort: effort || DEFAULT_EFFORT, images: imagePaths.length, ok: true })
  return { status: 200, ok: true, id }
}

// Shared front half of prompt/interrupt/queue: resolve the session, validate the
// text/image payload, stream any attachments into the container, and build the
// single-line payload. Returns { err } on rejection, else { s, payload, text, paths }.
async function prepare(id, text, images) {
  const s = registry.sessions[id]
  if (!s) return { err: { status: 404, ok: false, error: 'no such session' } }
  const imgs = Array.isArray(images) ? images : []
  const hasText = typeof text === 'string' && text.length > 0
  if (!hasText && !imgs.length) return { err: { status: 400, ok: false, error: 'text or images required' } }
  if (hasText && text.length > PROMPT_MAX_CHARS) return { err: { status: 400, ok: false, error: `text too long (max ${PROMPT_MAX_CHARS} chars)` } }
  if (imgs.length > MAX_IMAGES) return { err: { status: 400, ok: false, error: `too many files (max ${MAX_IMAGES})` } }
  if (!(await sessionAlive(s))) return { err: { status: 409, ok: false, error: 'session not running' } }
  let paths
  try {
    paths = imgs.length ? await writeImages(s.container, id, imgs) : []
  } catch (e) {
    return { err: { status: 400, ok: false, error: e.message } }
  }
  return { s, payload: withImages(hasText ? text : '', paths), text: hasText ? text : '', paths }
}

// Type a single-line payload into the session and submit it (Enter). Literal text
// (-l) as a single argv → no shell parsing; then a real Enter.
//
// Same sanitise-then-verify as the box-local executor, from the same module —
// `-l` is a keyboard, so an escape sequence in the text is parsed as keys and
// swallows the words around it (see api/src/tui-input.mjs for the measurement).
// One implementation, both executors: a second copy would drift and only one
// would get maintained.
async function deliver(s, payload) {
  const safe = sanitizeForTyping(payload)
  const stripped = payload.length - safe.length
  // ⚠️ Never type into a non-empty box — the typed text concatenates onto
  // whatever is there and the Enter submits the pair. Clearing is VERIFIED, not
  // counted: `C-u` kills a display ROW (api/src/tui-input.mjs carries the
  // measurement and the accumulation it explains).
  const io = {
    readPane: () => captureTail(s, TAIL_LINES, true),
    pressClear: () => dockerExec(s.container, ['tmux', 'send-keys', '-t', s.tmux, TUI_CLEAR_KEY]),
  }
  let cleared = 0
  if (TUI_VERIFY) {
    const pre = await clearInputBox(io)
    if (!pre.ok) {
      audit({ action: 'deliver-box-stuck', id: s.id, repo: s.repo, len: safe.length, presses: pre.presses, residue: pre.residue, ok: false })
      return { ok: false, error: 'input box is not empty and could not be cleared (nothing typed)' }
    }
    cleared = pre.presses
  }
  const t = await dockerExec(s.container, ['tmux', 'send-keys', '-t', s.tmux, '-l', safe])
  if (!t.ok) return { ok: false, error: t.stderr.slice(0, 500) || 'send-keys failed' }
  if (TUI_VERIFY && safe.length <= TUI_VERIFY_MAX_CHARS && !(await typedTextLanded(s, safe))) {
    const post = await clearInputBox(io)
    audit({ action: 'deliver-mangled', id: s.id, repo: s.repo, len: safe.length, stripped, presses: post.presses, emptied: post.ok, ok: false })
    return { ok: false, error: 'input did not land in the session (not submitted)' }
  }
  await dockerExec(s.container, ['tmux', 'send-keys', '-t', s.tmux, 'Enter'])
  return { ok: true, stripped, cleared }
}

// Read the typed text back off the pane before submitting — the pane lags the
// keystrokes, so look more than once. Mirrors the box-local executor.
async function typedTextLanded(s, payload) {
  for (let i = 0; i < TUI_VERIFY_TRIES; i++) {
    if (i) await sleep(TUI_VERIFY_SETTLE_MS)
    if (deliveryLanded(await captureTail(s, TAIL_LINES, true), payload)) return true
  }
  return false
}

// Remember that an Atlas orchestrator — not the operator — injected this prompt.
// It can't be marked in the transcript itself (it lands as an ordinary tmux-stdin
// user turn), so we keep a small per-session set of steered-prompt fingerprints
// and match them back when reconstructing history (tagSteered), which colors
// those bubbles apart in the chat view. Mirrors the box-local executor. Returns
// whether it recorded anything new (to gate the persist). Capped + persisted so
// the tagging survives a bridge restart, like the rest of the session record.
const STEER_KEYS_MAX = 60
function recordSteer(s, text, steeredBy, source) {
  if (!steeredBy || typeof text !== 'string' || !text.trim()) return false
  // `source` rides IN the entry (steerEntry) so the chat view can colour a
  // dashboard-derived line apart from an orchestrator's steer. A bare entry
  // still means 'atlas', which keeps already-persisted state — and a box that
  // predates this — working.
  const key = steerEntry(steerKey(text), source)
  if (!Array.isArray(s.steered)) s.steered = []
  if (s.steered.includes(key)) return false
  s.steered.push(key)
  if (s.steered.length > STEER_KEYS_MAX) s.steered = s.steered.slice(-STEER_KEYS_MAX)
  return true
}

async function prompt({ id, text, images, force, steeredBy }) {
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
  if (recordSteer(p.s, p.text, steeredBy)) persist()
  audit({ action: 'prompt', id, repo: p.s.repo, len: p.payload.length, images: p.paths.length, ...(steeredBy ? { steeredBy } : {}), ok: true })
  return { status: 200, ok: true }
}

// Interrupt the in-flight turn and steer with added context. Escape stops the
// current generation but KEEPS the transcript so far (a turn boundary, not a
// reset), so after the settle delay the agent resumes with everything plus the
// new input. Same validation/payload as prompt.
async function interrupt({ id, text, images, steeredBy }) {
  const p = await prepare(id, text, images)
  if (p.err) return p.err
  await dockerExec(p.s.container, ['tmux', 'send-keys', '-t', p.s.tmux, 'Escape'])
  await sleep(INTERRUPT_SETTLE_MS)
  const d = await deliver(p.s, p.payload)
  if (!d.ok) return { status: 502, ok: false, error: d.error }
  if (recordSteer(p.s, p.text, steeredBy)) persist()
  audit({ action: 'interrupt', id, repo: p.s.repo, len: p.payload.length, images: p.paths.length, ...(steeredBy ? { steeredBy } : {}), ok: true })
  return { status: 200, ok: true }
}

// Park a prompt to be delivered when the session next goes idle (the flush loop
// below sends it). Appends to the session's FIFO queue, so queueing again while one
// is parked keeps both (delivered in order). Images are streamed into the container
// now, at queue time.
async function queuePrompt({ id, text, images, kind, steeredBy, source }) {
  const p = await prepare(id, text, images)
  if (p.err) return p.err
  if (!Array.isArray(p.s.queued)) p.s.queued = []
  if (p.s.queued.length >= MAX_QUEUED) return { status: 409, ok: false, error: `queue full (max ${MAX_QUEUED})` }
  // `at` is the ENQUEUE time — the start of the interval flushQueued audits as
  // `waitMs`. `kind` is what WHEN is decided from (queue-delivery.mjs): the box
  // stamps it before forwarding here, and dropping it would make every bridge
  // entry read back as untagged, i.e. idle-only.
  p.s.queued.push({ text: p.text, paths: p.paths, at: nowIso(), ...(kind ? { kind } : {}) })
  // Record now (by text); the parked prompt is delivered at the next idle and the
  // fingerprint matches whenever that turn lands in the container transcript.
  recordSteer(p.s, p.text, steeredBy, source)
  persist()
  audit({ action: 'queue', id, repo: p.s.repo, len: p.payload.length, images: p.paths.length, depth: p.s.queued.length, ...(kind ? { kind } : {}), ok: true })
  return { status: 200, ok: true }
}

// Cancel a parked prompt. With a numeric `index`, drop just that one from the FIFO
// queue (the card's per-chip ×); without one, clear the whole queue.
function unqueue({ id, index }) {
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

// Deliver a session's queued prompt RIGHT NOW instead of waiting for the turn to
// end — the operator's "send now" on the ⏱ chip. Mirrors interrupt(): Escape the
// in-flight turn (work so far is kept), settle, then send the parked payload. The
// slot is claimed synchronously BEFORE any await so the flush timer can't also
// grab it; restored if the session is gone or the send fails.
async function sendNow({ id }) {
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
  await dockerExec(s.container, ['tmux', 'send-keys', '-t', s.tmux, 'Escape'])
  await sleep(INTERRUPT_SETTLE_MS)
  const d = await deliver(s, payload)
  if (!d.ok) {
    s.queued = [q, ...(s.queued || [])]
    persist()
    return { status: 502, ok: false, error: d.error }
  }
  audit({ action: 'queue-send-now', id, repo: s.repo, len: payload.length, images: (q.paths || []).length, ...(d.stripped ? { stripped: d.stripped } : {}), ...(d.cleared ? { cleared: d.cleared } : {}), ok: true })
  return { status: 200, ok: true }
}

// Deliver any queued prompts whose session has gone idle. Runs on a timer so a
// queued prompt fires even with the dashboard closed. Skips sessions still working
// (busy marker) or parked on a menu. Re-entrancy-guarded; failed sends retry next tick.
let flushing = false
async function flushQueued() {
  if (flushing) return
  flushing = true
  try {
    for (const s of Object.values(registry.sessions)) {
      if (!Array.isArray(s.queued) || !s.queued.length || s.status === 'error') continue
      // Backing off a head that keeps being refused (deliveryBackoffMs) — the
      // message stays queued, we just stop asking every 3 s.
      if (s.deliverRetryAt && Date.now() < s.deliverRetryAt) continue
      if (!(await sessionAlive(s))) continue
      const pane = await captureTail(s, TAIL_LINES)
      // ONE delivery per session per tick, in queue order — except that an
      // idle-only entry no longer BLOCKS the boundary-eligible ones behind it
      // (queue-delivery.mjs `selectDelivery`, the shared scan). No `revalidate`
      // here: the observational notes it drops are only ever addressed to a
      // box-local Atlas chat, so on a bridge that pass has nothing to look at
      // and the selection reduces to the scan.
      const sel = selectDelivery({
        queue: s.queued,
        busy: isBusy(pane),
        menu: !!menuKindOf(pane),
        // No ship train here: the serial merge queue is box-local (a remote agent
        // ships concurrently), so there is nothing on the bridge to hold delivery for.
        shipHead: false,
        boundaryEnabled: BOUNDARY_DELIVERY,
        sinceBoundaryMs: s.boundaryAt ? Date.now() - s.boundaryAt : null,
      })
      if (!sel.pick) continue
      const picked = new Set(sel.pick.entries)
      const q = sel.pick.entries[0]
      const dec = { via: sel.pick.via }
      const payload = withImages(deliveryText(sel.pick.entries, Date.now()), sel.pick.entries.flatMap((e) => e.paths || []))
      const d = await deliver(s, payload)
      if (!d.ok) {
        s.deliverFailures = (s.deliverFailures || 0) + 1
        const backoffMs = deliveryBackoffMs(s.deliverFailures)
        if (backoffMs) {
          s.deliverRetryAt = Date.now() + backoffMs
          console.error(`[bridge] delivery to ${s.id} refused ${s.deliverFailures}x (${d.error}) — holding ${Math.round(backoffMs / 1000)}s; the message stays queued`)
          audit({ action: 'queue-backoff', id: s.id, repo: s.repo, failures: s.deliverFailures, backoffMs, error: d.error, ok: false })
        }
        persist()
        continue
      }
      delete s.deliverFailures
      delete s.deliverRetryAt
      // Stamp the mid-turn delivery so the next one is paced (BOUNDARY_MIN_GAP_MS)
      // rather than following on the next 3 s tick — at idle the pacing came free
      // (delivery made the agent busy), mid-turn nothing paces it.
      if (dec.via === 'boundary') s.boundaryAt = Date.now()
      // By identity, never by index — `selectDelivery` may hand back an entry
      // that was not the head (a boundary message overtaking an idle-only one).
      s.queued = s.queued.filter((e) => !picked.has(e))
      if (!s.queued.length) delete s.queued
      persist()
      // waitMs: enqueue → actual delivery. Same field names as the box's
      // queue-flush line, so one grep separates boundary from idle across both.
      const waitMs = q.at ? Date.now() - Date.parse(q.at) : null
      audit({ action: 'queue-flush', id: s.id, repo: s.repo, len: payload.length, images: (q.paths || []).length, ...(d.stripped ? { stripped: d.stripped } : {}), ...(d.cleared ? { cleared: d.cleared } : {}), ...(waitMs != null && waitMs >= 0 ? { waitMs } : {}), via: dec.via, ...(q.kind ? { kind: q.kind } : {}), ok: true })
    }
  } finally {
    flushing = false
  }
}
const flushTimer = setInterval(() => flushQueued().catch(() => {}), QUEUE_FLUSH_MS)
if (flushTimer.unref) flushTimer.unref()

// Allowlisted tmux key tokens for driving Claude Code's interactive menus
// (arrow-select prompts, plan approval, the rare permission dialog). Sent
// WITHOUT `-l`, so tmux interprets the names; Enter is an explicit key here, not
// auto-appended like the free-text `prompt` path. The allowlist is the boundary.
const ALLOWED_KEYS = new Set([
  'Up', 'Down', 'Left', 'Right', 'Enter', 'Escape', 'Space', 'Tab',
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
])

async function keys({ id, keys: ks }) {
  const s = registry.sessions[id]
  if (!s) return { status: 404, ok: false, error: 'no such session' }
  if (!Array.isArray(ks) || !ks.length) return { status: 400, ok: false, error: 'keys required' }
  if (ks.length > 16) return { status: 400, ok: false, error: 'too many keys' }
  for (const k of ks)
    if (!ALLOWED_KEYS.has(k)) return { status: 400, ok: false, error: `key not allowed: ${k}` }
  if (!(await sessionAlive(s))) return { status: 409, ok: false, error: 'session not running' }
  const r = await dockerExec(s.container, ['tmux', 'send-keys', '-t', s.tmux, ...ks])
  if (!r.ok) return { status: 502, ok: false, error: r.stderr.slice(0, 500) || 'send-keys failed' }
  audit({ action: 'keys', id, repo: s.repo, keys: ks, ok: true })
  return { status: 200, ok: true }
}

// Verified selection of a pending choice-menu option — mirrors the box-local
// executor's selectChoice: navigate the ❯ highlight toward the option whose
// TEXT is `optionText`, never trusting `hintN` for anything but an initial
// direction, confirming by content at every step (driveSelect, menu.mjs), and
// press Enter ONLY once it's confirmed there.
async function selectChoice({ id, optionText, hintN }) {
  const s = registry.sessions[id]
  if (!s) return { status: 404, ok: false, error: 'no such session' }
  if (typeof optionText !== 'string' || !optionText.trim()) return { status: 400, ok: false, error: 'optionText required' }
  if (!(await sessionAlive(s))) return { status: 409, ok: false, error: 'session not running' }
  const readHighlight = async () => {
    const pane = await captureTail(s, TAIL_LINES)
    return menuKindOf(pane) === 'choice' ? currentHighlight(pane) : null
  }
  const sendKey = async (key) => {
    const r = await dockerExec(s.container, ['tmux', 'send-keys', '-t', s.tmux, key])
    if (r.ok) await sleep(SELECT_STEP_MS)
    return r.ok
  }
  const result = await driveSelect({ target: optionText, hintN, sendKey, readHighlight })
  if (!result.ok) return { status: 409, ok: false, error: result.error }
  audit({ action: 'select', id, repo: s.repo, text: optionText, ok: true })
  return { status: 200, ok: true }
}

async function kill({ id }) {
  const s = registry.sessions[id]
  if (!s) return { status: 404, ok: false, error: 'no such session' }
  // Kill the tmux session only — the worktree + agent/<id> branch persist on
  // disk for you to review/merge (HANDBOOK: kill leaves them in place).
  await dockerExec(s.container, ['tmux', 'kill-session', '-t', s.tmux])
  delete registry.sessions[id]
  persist()
  audit({ action: 'kill', id, repo: s.repo, branch: s.branch, worktree: s.worktree, ok: true })
  return { status: 200, ok: true }
}

// kill + REMOVE the worktree + DELETE the branch — for an agent whose work is
// merged or abandoned. Destructive (branch gone); the card confirms first.
async function cleanup({ id }) {
  const s = registry.sessions[id]
  if (!s) return { status: 404, ok: false, error: 'no such session' }
  await dockerExec(s.container, ['tmux', 'kill-session', '-t', s.tmux])
  await dockerExec(s.container, ['git', '-C', s.path, 'worktree', 'remove', s.worktree, '--force'])
  await dockerExec(s.container, ['git', '-C', s.path, 'branch', '-D', s.branch])
  await dockerExec(s.container, ['rm', '-rf', `/tmp/agent-uploads/${id}`])
  await dockerExec(s.container, ['rm', '-f', statsFile(id)])
  await dockerExec(s.container, ['rm', '-rf', downloadsDir(id)])
  delete registry.sessions[id]
  persist()
  audit({ action: 'cleanup', id, repo: s.repo, branch: s.branch, worktree: s.worktree, ok: true })
  return { status: 200, ok: true }
}

async function output({ id, lines }) {
  const s = registry.sessions[id]
  if (!s) return { status: 404, ok: false, error: 'no such session' }
  // Grow the pane so the transcript carries more than the default 80x24 window;
  // wait a beat after an actual grow for Claude to re-render into it.
  if (await ensurePaneTall(s)) await sleep(150)
  const n = Math.min(Math.max(Number(lines) || 200, 1), 2000)
  const tail = collapseBlankRuns(await captureTail(s, n, true))
  return { status: 200, ok: true, id, output: tail }
}

// Full chat history for a workstation dev agent — the COMPLETE conversation from
// its on-disk Claude Code `.jsonl` transcript(s) INSIDE the container, stitched
// across resume-forked files (unlike output(), the live tmux tail). Bridge sessions
// are all dev agents (unique per-worktree project dir), so we enumerate every
// `.jsonl` there. Reuses the box's pure parser (parseTranscript/stitchParsed).
const HISTORY_MAX_BYTES = Number(process.env.BRIDGE_HISTORY_MAX_BYTES || 24 * 1024 * 1024)
async function readContainerHistory(s) {
  if (!s.worktree) return { messages: [], sessions: 0, truncated: false }
  const key = projectKey(s.worktree) // alnum+dash only → safe to interpolate
  // Dump every .jsonl newest-first, each preceded by a marker line (JSON lines
  // start with '{', so the marker never collides), bounded to HISTORY_MAX_BYTES.
  // stitchParsed re-orders by timestamp, so dump order doesn't matter.
  const cmd =
    `d="$HOME/.claude/projects/${key}"; cd "$d" 2>/dev/null || exit 0; ` +
    `for f in $(ls -t *.jsonl 2>/dev/null); do printf '@@ATLAS_HFILE\\n'; cat "$f"; done | head -c ${HISTORY_MAX_BYTES}`
  const r = await new Promise((resolve) => {
    execFile(
      'docker',
      ['exec', s.container, 'sh', '-lc', cmd],
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: HISTORY_MAX_BYTES + 1024 * 1024 },
      (err, stdout) => resolve({ ok: !err, stdout: stdout || '' }),
    )
  })
  if (!r.ok || !r.stdout) return { messages: [], sessions: 0, truncated: false }
  const chunks = r.stdout.split(/(?:^|\n)@@ATLAS_HFILE\n/).filter((c) => c.trim())
  const stitched = stitchParsed(chunks.map((c) => parseTranscript(c)))
  // Color prompts an Atlas orchestrator injected apart from the operator's own
  // input (recorded at steer time; matched by fingerprint) — same as the box.
  const steerSet = new Set(Array.isArray(s.steered) ? s.steered : [])
  if (steerSet.size) tagSteered(stitched.messages, steerSet)
  return stitched
}
// Fingerprint of the container's transcript file set + sizes — one cheap docker
// exec, so the live poll's `rev` echo can skip the multi-MB dump + parse above
// when nothing changed. '' (e.g. exec failure) disables the skip for that call.
async function containerHistoryRev(s) {
  if (!s.worktree) return ''
  const key = projectKey(s.worktree)
  const cmd = `d="$HOME/.claude/projects/${key}"; cd "$d" 2>/dev/null || exit 0; stat -c '%n:%s' *.jsonl 2>/dev/null | sort`
  const r = await new Promise((resolve) => {
    execFile('docker', ['exec', s.container, 'sh', '-lc', cmd], { timeout: EXEC_TIMEOUT_MS }, (err, stdout) =>
      resolve({ ok: !err, stdout: stdout || '' }),
    )
  })
  if (!r.ok) return ''
  // Fold the steer set in too, so a newly-recorded steer invalidates the poll's
  // rev skip and the box refetches a freshly-tagged history (mirrors revOf).
  const steerSig = Array.isArray(s.steered) && s.steered.length ? [...s.steered].sort().join(',') : ''
  return crypto.createHash('sha1').update(`${r.stdout}||${steerSig}`).digest('hex').slice(0, 16)
}
async function history({ id, rev }) {
  const s = registry.sessions[id]
  if (!s) return { status: 404, ok: false, error: 'no such session' }
  try {
    const cur = await containerHistoryRev(s)
    if (rev && cur && rev === cur) return { status: 200, ok: true, id, unchanged: true, rev: cur }
    return { status: 200, ok: true, id, rev: cur, ...(await readContainerHistory(s)) }
  } catch (e) {
    return { status: 500, ok: false, error: String(e?.message || e) }
  }
}

/* --- redeploy (the dashboard's phone-triggered "Redeploy bridge" button) --- *
 * Runs scripts/restart-agent-bridge.sh — the SAME script an operator runs by
 * hand over SSH, kept as the single source of redeploy truth — launched via a
 * transient `systemd-run` unit, NOT a plain detached child. `detached: true`
 * only opens a new SESSION; the child stays in THIS process's cgroup, and
 * atlas-kit-agent-bridge.service's default KillMode=control-group means the
 * script's own `systemctl restart` SIGTERMs it right after it writes `state
 * deploying restart` — before pull/health/done ever land. That's why
 * systemd-run is load-bearing: it escapes into its own transient unit/cgroup,
 * which the restart can't reach. Falls back to the old best-effort detached
 * spawn when systemd-run itself isn't available (a manual, non-systemd run of
 * the bridge). Phase transitions (pull/restart/health, then done or error) land
 * in REDEPLOY_STATE via the script's optional state() writer
 * (REDEPLOY_STATE_FILE env — see the script's header); GET /redeploy-status
 * reads it back for the box's poll. Fixed, parameterless: pulls this repo's own
 * default branch and restarts this one systemd service — never arbitrary exec. */
const REDEPLOY_SCRIPT = path.join(ROOT, 'scripts', 'restart-agent-bridge.sh')
const REDEPLOY_STATE = process.env.BRIDGE_REDEPLOY_STATE || '/tmp/atlas-kit-bridge-redeploy-state.json'
const REDEPLOY_LOG = process.env.BRIDGE_REDEPLOY_LOG || '/tmp/atlas-kit-bridge-redeploy.log'
// Fixed transient-unit name — a collision here (still loaded/active) is a
// concurrent redeploy in flight; see isUnitCollisionError below.
const REDEPLOY_UNIT = process.env.BRIDGE_REDEPLOY_UNIT || 'atlas-kit-bridge-redeploy'
// A redeploy already in flight (state "deploying") more recently than this is
// refused as a 409 rather than launching a second overlapping pull; older than
// this is treated as abandoned (e.g. the detached script died unnoticed) so a
// wedged state file can't block redeploys forever.
const REDEPLOY_STALE_MS = Number(process.env.BRIDGE_REDEPLOY_STALE_MS || 10 * 60 * 1000)

function readRedeployState() {
  try {
    return JSON.parse(fs.readFileSync(REDEPLOY_STATE, 'utf-8'))
  } catch {
    return null
  }
}

// Best-effort fallback for when systemd-run isn't on PATH (a manual,
// non-systemd run of the bridge) — the pre-systemd-run behaviour, with the
// same cgroup-kill caveat it existed under.
function spawnRedeployDetached() {
  spawnProcess('bash', ['-lc', `exec ${shquote(REDEPLOY_SCRIPT)} >>${shquote(REDEPLOY_LOG)} 2>&1`], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, REDEPLOY_STATE_FILE: REDEPLOY_STATE },
  }).unref()
}

async function redeploy() {
  const cur = readRedeployState()
  if (cur && cur.phase === 'deploying' && Date.now() - Date.parse(cur.at || 0) < REDEPLOY_STALE_MS) {
    return { status: 409, ok: false, error: `redeploy already in progress (${cur.step})`, redeploy: cur }
  }
  const args = buildRedeploySystemdRunArgs({
    unit: REDEPLOY_UNIT,
    stateFile: REDEPLOY_STATE,
    pullUser: process.env.BRIDGE_PULL_USER,
    script: REDEPLOY_SCRIPT,
    log: REDEPLOY_LOG,
    cwd: ROOT,
  })
  try {
    execFileSync('systemd-run', args, { stdio: 'pipe', encoding: 'utf-8' })
  } catch (e) {
    if (e.code === 'ENOENT') {
      spawnRedeployDetached()
    } else if (isUnitCollisionError(e)) {
      return { status: 409, ok: false, error: 'redeploy already in progress (unit active)', redeploy: cur }
    } else {
      const detail = String(e.stderr || e.message || e)
      audit({ action: 'redeploy', ok: false, error: detail })
      return { status: 500, ok: false, error: detail }
    }
  }
  audit({ action: 'redeploy', ok: true })
  return { status: 202, ok: true, started: true }
}

function redeployStatus() {
  return { status: 200, ok: true, redeploy: readRedeployState() }
}

/* --- http plumbing ------------------------------------------------- */
function send(res, status, body) {
  const s = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(s)
}

function authed(req) {
  const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i)
  return m && timingSafeEqual(m[1], TOKEN)
}

function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > maxBytes) req.destroy() // hard cap
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://bridge')
    const p = url.pathname

    if (req.method === 'GET' && p === '/health') {
      // `features` is how the box decides a spawn's prompt TRANSPORT before it
      // sizes the prompt — see FEATURES. `capacity` is this box's own memory +
      // live-session reading (agentCapacity above), on the channel the box
      // ALREADY polls — no new endpoint, no heartbeat. Its PRESENCE is also the
      // capability signal: a bridge that predates this simply has no `capacity`
      // key and the box then spawns as it always did (fail-open — see
      // agent-routes.mjs). Deliberately not added to FEATURES too: two signals
      // for one capability can disagree, and this one carries its own evidence.
      return send(res, 200, { ok: true, service: 'agent-bridge', sha: startupSha, features: FEATURES, capacity: agentCapacity() })
    }
    // Agent→agent mail from a CONTAINER. Authed by the sending session's own
    // scoped token, so it is handled before the bridge-bearer gate — an agent
    // must never hold the bridge bearer (that would be spawn/kill on every repo).
    if (req.method === 'POST' && p === '/api/agents/message') {
      const body = await readBody(req, MSG_TEXT_MAX + 4096)
      if (body == null) return send(res, 400, { ok: false, error: 'invalid JSON body' })
      const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i)
      const r = await agentMessage(body, m ? m[1].trim() : '')
      const { status, ...rest } = r
      return send(res, status, rest)
    }
    // A CONTAINER agent's read-only Atlas query — same scoped-token auth, so it
    // is likewise handled before the bridge-bearer gate.
    if (req.method === 'POST' && p === '/api/atlas/query') {
      const body = await readBody(req)
      if (body == null) return send(res, 400, { ok: false, error: 'invalid JSON body' })
      const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i)
      const { status, ...rest } = await atlasQuery(body, m ? m[1].trim() : '')
      return send(res, status, rest)
    }
    if (!authed(req)) return send(res, 401, { ok: false, error: 'unauthorized' })

    // Live-app reverse proxy (HTTP) — streams to the container app, so it runs
    // BEFORE any JSON body read. The box injects the bridge bearer (checked
    // above), so this stays as protected as every other bridge route.
    if (p.startsWith('/agent-app/')) return appProxyHttp(req, res)

    if (req.method === 'GET' && p === '/sessions') {
      return send(res, 200, { generated: nowIso(), sessions: await listSessions() })
    }
    if (req.method === 'GET' && p === '/output') {
      const r = await output({ id: url.searchParams.get('id'), lines: url.searchParams.get('lines') })
      return send(res, r.status, r)
    }
    if (req.method === 'GET' && p === '/history') {
      const r = await history({ id: url.searchParams.get('id'), rev: url.searchParams.get('rev') || '' })
      return send(res, r.status, r)
    }
    if (req.method === 'GET' && p === '/download') {
      // Awaited (unlike a plain `return streamDownload(...)`) so a rejection
      // lands in the surrounding try/catch, same as every other route here.
      return await streamDownload(res, url.searchParams.get('id'), url.searchParams.get('name'))
    }
    if (req.method === 'GET' && p === '/redeploy-status') {
      const r = redeployStatus()
      return send(res, r.status, r)
    }
    const POST_ROUTES = { '/spawn': spawn, '/prompt': prompt, '/interrupt': interrupt, '/queue': queuePrompt, '/unqueue': unqueue, '/send-now': sendNow, '/kill': kill, '/cleanup': cleanup, '/keys': keys, '/select': selectChoice, '/redeploy': redeploy, '/outbox': takeOutbox }
    if (req.method === 'POST' && POST_ROUTES[p]) {
      // spawn/prompt/interrupt/queue may carry base64 image attachments → a roomier
      // cap. /outbox joins them: an Atlas-query verdict carries the ANSWER, and a
      // drain can hand back several at once — at 64 KB the batch would be destroyed
      // mid-body and every waiting agent would time out instead of being answered.
      const big = p === '/spawn' || p === '/prompt' || p === '/interrupt' || p === '/queue' || p === '/outbox'
      const body = await readBody(req, big ? PROMPT_BODY_LIMIT : 64 * 1024)
      if (body == null) return send(res, 400, { ok: false, error: 'invalid JSON body' })
      const r = await POST_ROUTES[p](body)
      const { status, ...rest } = r
      return send(res, status, rest)
    }
    return send(res, 404, { ok: false, error: 'not found' })
  } catch (e) {
    return send(res, 500, { ok: false, error: e?.message || String(e) })
  }
})

// Hold an idle keep-alive socket FAR longer than Node's 5 s default, because the
// box can be unable to answer for tens of seconds while still holding the socket
// it is about to POST on. The Atlas retrieval folded into every spawn prompt runs
// IN-PROCESS in the box's Express, immediately BEFORE callBridge, and with a
// semantic leg enabled it takes 14–22 s. The box polls /sessions every 3 s, so
// its HTTP pool always holds a warm socket here; during that starved stretch the
// socket ages past 5 s, we send FIN, the box's event loop never processes it, and
// the POST /spawn that follows resets INSTANTLY (~100–250 ms, against a 30 s
// timeout budget). Reads survived because the client retries idempotent GETs and
// never POSTs, which is why only spawn broke. Measured over the complete history
// of remote spawns (n=11, no overlap): retrievals of 560/593/1010/4536/4813 ms
// all spawned; 13985/14636/17234/19538/20303/22398 ms all failed.
// ⚠️ headersTimeout MUST stay ABOVE keepAliveTimeout — Node reintroduces exactly
// this race if the headers deadline can fire first on a reused socket.
const KEEPALIVE_TIMEOUT_MS = Number(process.env.BRIDGE_KEEPALIVE_TIMEOUT_MS || 60000)
server.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS
server.headersTimeout = KEEPALIVE_TIMEOUT_MS + 5000

// WebSocket upgrades for the live-app proxy (Streamlit's /_stcore/stream). The
// box forwards the upgrade with the bridge bearer injected, so we gate it the
// same as the HTTP routes; anything else is closed.
server.on('upgrade', (req, socket, head) => {
  try {
    const p = new URL(req.url, 'http://bridge').pathname
    if (!p.startsWith('/agent-app/') || !authed(req)) return socket.destroy()
    appProxyUpgrade(req, socket, head).catch(() => socket.destroy())
  } catch {
    socket.destroy()
  }
})

if (!TOKEN) {
  console.error('FATAL: BRIDGE_TOKEN is unset — refusing to start (would be open RCE).')
  process.exit(1)
}
// Validate the allowlist exists up front so misconfig fails loud, not at spawn.
try {
  loadRepos()
} catch (e) {
  console.error(`FATAL: ${e.message}`)
  process.exit(1)
}
server.listen(PORT, HOST, () => {
  console.log(`agent-bridge listening on http://${HOST}:${PORT}  (repos: ${REPOS_FILE})`)
})
