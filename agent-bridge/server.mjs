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
 *   POST /spawn   { task, repo, preamble?, model?, effort?, images? }  → { ok, id }
 *   POST /prompt  { id, text, images? }  → { ok }   (images: data-URL uploads)
 *   POST /kill    { id }          → { ok }
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
import { execFile } from 'node:child_process'
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
import { parseTranscript, stitchParsed, steerKey, tagSteered } from '../api/src/agent-history.mjs'
import { parseChoiceMenu } from '../api/src/menu.mjs'

const PORT = Number(process.env.BRIDGE_PORT || 7878)
// Default to loopback: refuse to be reachable until the operator deliberately
// binds the tailnet IP (the installer sets this from `tailscale ip -4`).
const HOST = process.env.BRIDGE_HOST || '127.0.0.1'
const TOKEN = process.env.BRIDGE_TOKEN || ''
const HERE = path.dirname(new URL(import.meta.url).pathname)
const REPOS_FILE = process.env.BRIDGE_REPOS || path.join(HERE, 'repos.json')
const STATE_FILE = process.env.BRIDGE_STATE || path.join(HERE, 'state.json')
const AUDIT_LOG = process.env.BRIDGE_AUDIT_LOG || path.join(HERE, 'audit.log')
// `{task}`/`{model}`/`{effort}` are substituted with shell-quoted per-spawn
// values from the dashboard; the proxy validates them and resolves the model ID
// (Opus/Fable carry the `[1m]` extended-context suffix by default; Sonnet does
// not, since its 1M variant needs usage credits — see AGENT_EXTENDED_CONTEXT in
// agent-routes.mjs). A custom AGENT_LAUNCH_CMD without the placeholders simply
// keeps whatever it hardcodes.
const LAUNCH_CMD =
  process.env.AGENT_LAUNCH_CMD ||
  'IS_SANDBOX=1 claude --model {model} --effort {effort} --dangerously-skip-permissions {task}'
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
// `s.queued` is a FIFO of parked prompts; cap its depth so a stuck agent that
// never flushes can't grow the persisted state without bound.
const MAX_QUEUED = Number(process.env.BRIDGE_MAX_QUEUED || 20)
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

/* --- tiny helpers -------------------------------------------------- */
const nowIso = () => new Date().toISOString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
function publicView(s, status, lastOutput, menuKind, appUp, stats, menuChoice) {
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
    ...(menuChoice
      ? {
          menuOptions: menuChoice.options,
          menuHighlighted: menuChoice.highlighted,
          ...(menuChoice.question ? { menuQuestion: menuChoice.question } : {}),
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
    // Agent-signaled ship state (ATLAS:READY-TO-SHIP / ATLAS:SHIPPED markers,
    // scanned sticky off the container transcript) — so a workstation dev agent's
    // card lights the same ready ⤴ / shipped ✓ iconography as a box-local one.
    ...(s.shipState ? { shipState: s.shipState, ...(s.shipInfo ? { shipInfo: s.shipInfo } : {}) } : {}),
    // Tmux vanished out from under a still-registered session (host/container
    // restart, kill-server) — the card renders this as "lost", not "done".
    ...(s.interrupted ? { interrupted: true } : {}),
  }
}

/* --- endpoint handlers --------------------------------------------- */
async function listSessions() {
  const out = []
  let changed = false
  // Probe each SESSION's own live-app port (per-session now, not per-repo).
  const appUpFor = async (id) => {
    const t = await appTarget(id)
    return t ? await probeTcp(t.host, t.port) : false
  }
  for (const s of Object.values(registry.sessions)) {
    if (s.status === 'error') {
      out.push(publicView(s, 'error', s.error || 'spawn failed', null, await appUpFor(s.id)))
      continue
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
    // Scan the container transcript for sub-agents / background jobs / context
    // fill (sticky logs persisted on the session). Only while alive — a dead
    // session has nothing new, and its transcript may be gone with the container.
    if (alive && mergeTranscript(s, await readContainerTranscript(s))) changed = true
    out.push(publicView(s, status, tail || s.lastSeen || '', menuKind, await appUpFor(s.id), stats, menuChoice))
  }
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

// Claude Code prints "esc to interrupt" in its status line ONLY while a turn is
// actively running; the moment it finishes and waits for the next prompt that
// marker is gone. So a live tmux session showing it = working ('running'); a
// live one without it = the agent is blocked on YOU ('idle' / needs input).
const BUSY_MARKER = /esc to interrupt/i
function isBusy(pane) {
  return BUSY_MARKER.test(pane)
}

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

async function spawn({ task, repo, preamble, model, effort, images }) {
  if (!task || typeof task !== 'string') return { status: 400, ok: false, error: 'task required' }
  if (!repo || typeof repo !== 'string') return { status: 400, ok: false, error: 'repo required' }

  const repos = loadRepos()
  const target = repos[repo]
  if (!target) return { status: 400, ok: false, error: `unknown repo "${repo}"` }

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
  // live-stats dir so a bare `>` redirect to {statsFile} from the agent just works.
  await dockerExec(container, ['mkdir', '-p', worktreeBase])
  await dockerExec(container, ['mkdir', '-p', '/tmp/agent-stats'])
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
  // {statsFile} its container-side live-stats path (mirrors the box-local executor).
  const prompt = preamble
    ? `${injectApp(preamble.replaceAll('{statsFile}', statsFile(id)), repo, id, appPort)}\n\n---\n# Your task\n${withImages(task, imagePaths)}`
    : withImages(task, imagePaths)
  const launch = LAUNCH_CMD
    .replace('{model}', shquote(model || DEFAULT_MODEL))
    .replace('{effort}', shquote(effort || DEFAULT_EFFORT))
    .replace('{task}', shquote(prompt))
  const ns = await dockerExec(container, [
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
  if (hasText && text.length > 8000) return { err: { status: 400, ok: false, error: 'text too long' } }
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
async function deliver(s, payload) {
  const t = await dockerExec(s.container, ['tmux', 'send-keys', '-t', s.tmux, '-l', payload])
  if (!t.ok) return { ok: false, error: t.stderr.slice(0, 500) || 'send-keys failed' }
  await dockerExec(s.container, ['tmux', 'send-keys', '-t', s.tmux, 'Enter'])
  return { ok: true }
}

// Remember that an Atlas orchestrator — not the operator — injected this prompt.
// It can't be marked in the transcript itself (it lands as an ordinary tmux-stdin
// user turn), so we keep a small per-session set of steered-prompt fingerprints
// and match them back when reconstructing history (tagSteered), which colors
// those bubbles apart in the chat view. Mirrors the box-local executor. Returns
// whether it recorded anything new (to gate the persist). Capped + persisted so
// the tagging survives a bridge restart, like the rest of the session record.
const STEER_KEYS_MAX = 60
function recordSteer(s, text, steeredBy) {
  if (!steeredBy || typeof text !== 'string' || !text.trim()) return false
  const key = steerKey(text)
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
async function queuePrompt({ id, text, images, steeredBy }) {
  const p = await prepare(id, text, images)
  if (p.err) return p.err
  if (!Array.isArray(p.s.queued)) p.s.queued = []
  if (p.s.queued.length >= MAX_QUEUED) return { status: 409, ok: false, error: `queue full (max ${MAX_QUEUED})` }
  p.s.queued.push({ text: p.text, paths: p.paths })
  // Record now (by text); the parked prompt is delivered at the next idle and the
  // fingerprint matches whenever that turn lands in the container transcript.
  recordSteer(p.s, p.text, steeredBy)
  persist()
  audit({ action: 'queue', id, repo: p.s.repo, len: p.payload.length, images: p.paths.length, depth: p.s.queued.length, ok: true })
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
  audit({ action: 'queue-send-now', id, repo: s.repo, len: payload.length, images: (q.paths || []).length, ok: true })
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
      if (!(await sessionAlive(s))) continue
      const pane = await captureTail(s, TAIL_LINES)
      if (isBusy(pane) || menuKindOf(pane)) continue
      // One per idle tick: deliver the FIFO head, leave the rest for later ticks
      // (the agent goes busy on this one, so each queued prompt gets its own turn).
      const q = s.queued[0]
      const payload = withImages(q.text || '', q.paths || [])
      const d = await deliver(s, payload)
      if (!d.ok) continue
      s.queued.shift()
      if (!s.queued.length) delete s.queued
      persist()
      audit({ action: 'queue-flush', id: s.id, repo: s.repo, len: payload.length, images: (q.paths || []).length, ok: true })
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
      return send(res, 200, { ok: true, service: 'agent-bridge' })
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
    const POST_ROUTES = { '/spawn': spawn, '/prompt': prompt, '/interrupt': interrupt, '/queue': queuePrompt, '/unqueue': unqueue, '/send-now': sendNow, '/kill': kill, '/cleanup': cleanup, '/keys': keys }
    if (req.method === 'POST' && POST_ROUTES[p]) {
      // spawn/prompt/interrupt/queue may carry base64 image attachments → a roomier cap.
      const big = p === '/spawn' || p === '/prompt' || p === '/interrupt' || p === '/queue'
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
