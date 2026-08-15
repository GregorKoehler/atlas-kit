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
import { randomUUID, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  projectKey, tailLines, scanContextTokens, scanShipMarker, scanNowMarker,
  collectSubAgents, mergeSubAgentLog,
  collectBackgroundJobs, mergeBackgroundJobLog,
} from './subagent-scan.mjs'
import { sharedCheckoutWarning } from './shared-checkout.mjs'
import { claudeBinInfo, claudeShellWord } from './claude-bin.mjs'
import { mergedVerdict, mergedInfo, MERGE_LOG_FORMAT } from './merged-check.mjs'
import { preflightVerdict } from './merge-preflight.mjs'
import { generateMicros } from './agent-titles.mjs'
import { readHistory, steerKey, steerEntry } from './agent-history.mjs'
import { MSG_WRAPPER_SRC } from './agent-msg-wrapper.mjs'
import { parseChoiceMenu, currentHighlight, driveSelect } from './menu.mjs'
import { resolveVault, defaultVaultKey, isTypedVault } from './vaults.mjs'
// Optional model-BACKEND profiles: same harness, different Anthropic-compatible
// endpoint. Absent file / absent `provider` ⇒ every launch is unchanged.
import { resolveProvider } from './providers.mjs'
import { enqueueAtlasMerge } from './atlas-commit-queue.mjs'
import { updateProjectNow } from './project-card.mjs'
import { trackPhase, recordLifetime, revivePhase, aggregate, PHASE_HOLD_MS } from './agent-timings.mjs'
import {
  S as LC, ACT, decide, applyTransition, migrateSession, mirrorState,
  initLifecycle, isClosing, isInert, QUIESCENT,
} from './agent-lifecycle.mjs'
export { monthRunMsByRepo } from './agent-timings.mjs'
// The queued-prompt delivery gate, shared with the bridge executor so the two
// cannot drift: one per-kind classification, one menu/pacing rule, one test.
import { deliveryBackoffMs, selectDelivery, deliveryText, isObservational } from './queue-delivery.mjs'
import { capacityVerdict, readMemStatus } from './agent-capacity.mjs'
// Is a turn running? Two witnesses — the footer's `esc to interrupt` marker and
// the spinner line above the input box — because the footer is rendered to the
// pane width and drops that marker mid-turn. Shared, not copied.
import { isBusy } from './pane-busy.mjs'
import { sanitizeForTyping, deliveryLanded, clearInputBox, TUI_CLEAR_KEY, TUI_VERIFY, TUI_VERIFY_MAX_CHARS, TUI_VERIFY_SETTLE_MS, TUI_VERIFY_TRIES } from './tui-input.mjs'
// A launch prompt travels by FILE, never inside the tmux command — the shell
// shape is shared with the bridge executor so the two cannot drift.
import { promptFileBody, promptFileCommand } from './prompt-file-launch.mjs'
// Server-side Atlas retrieval: what a dev agent (and an Atlas chat) opens with.
import { buildCandidates, evidencePrompt } from './atlas-candidates.mjs'
// The bus log — where a note dropped as stale stays visible (delivered: false).
import { appendMessage } from './agent-messages.mjs'

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
// It sits in the `{claudeEnv}` slot because a PROVIDER PROFILE (providers.mjs)
// owns the Anthropic env outright — see providerLaunch() below.
// Box-local DEV agents load dev.mcp.json: the knowledge-only MCP profile, i.e.
// the seven READ tools over the vault (query_atlas/query_vault/get_note/…) and
// nothing that writes. They are told they have them in their preamble
// (ATLAS_SEARCH_PREAMBLE) — tools nobody announces go unused.
// ⚠️ `--strict-mcp-config` also REPLACES any `.mcp.json` the spawned repo ships.
const DEV_MCP_CONFIG = `${WORKSPACE}/api/src/mcp/dev.mcp.json`
// The launch templates spell `claude` as an ABSOLUTE, shell-quoted path resolved
// once at boot (claude-bin.mjs). `sh -lc` rebuilds PATH from /etc/profile, which
// does not include ~/.local/bin where a real install put the binary — so an API
// started by the watchdog cron or by systemd used to spawn every agent into an
// ENOENT while an interactive `serve.sh restart` worked. A custom
// AGENT_*_LAUNCH_CMD is left exactly as the operator wrote it.
const CLAUDE = claudeShellWord()
export const LAUNCH_CMD =
  process.env.AGENT_LOCAL_LAUNCH_CMD ||
  `IS_SANDBOX=1 env {claudeEnv}${CLAUDE} --model {model} --effort {effort} --mcp-config ${DEV_MCP_CONFIG} --strict-mcp-config --dangerously-skip-permissions {task}`
// Knowledge agents (vault chats) additionally pin `--session-id {sid}`: they all
// share the vault as cwd, so without a pinned id the transcript reader's
// newest-file heuristic would cross-read between concurrent chats.
const KNOWLEDGE_LAUNCH_CMD =
  process.env.AGENT_KNOWLEDGE_LAUNCH_CMD ||
  `IS_SANDBOX=1 env -u ANTHROPIC_API_KEY ${CLAUDE} --model {model} --effort {effort} --session-id {sid} --dangerously-skip-permissions {task}`
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
  `IS_SANDBOX=1 ATLAS_SESSION={atlasSession} env -u ANTHROPIC_API_KEY ${CLAUDE} --model {model} --effort {effort} --session-id {sid} --mcp-config ${CONTROL_MCP_CONFIG} --strict-mcp-config --dangerously-skip-permissions {task}`
// The PAIRED ATLAS WORKER is a restricted, dashboard-driven session — the same
// knowledge-only READ profile a dev agent gets (worker.mcp.json), and never the
// orchestrator's control tools. It writes the Atlas through its own worktree, not
// through a tool.
const WORKER_MCP_CONFIG = `${WORKSPACE}/api/src/mcp/worker.mcp.json`
const ATLAS_WORKER_LAUNCH_CMD =
  process.env.AGENT_ATLAS_WORKER_LAUNCH_CMD ||
  `IS_SANDBOX=1 env -u ANTHROPIC_API_KEY ${CLAUDE} --model {model} --effort {effort} --session-id {sid} --mcp-config ${WORKER_MCP_CONFIG} --strict-mcp-config --dangerously-skip-permissions {task}`
// Extended (1M) context is the DEFAULT and applies to EVERY model — the
// subscription serves the 1M window without usage credits — so the fallback model
// + the meter's window default to it. AGENT_EXTENDED_CONTEXT=0 (or false/no/off)
// is the global kill-switch back to the standard window. Kept in sync with the
// proxy's resolution in agent-routes.mjs.
const EXTENDED_CONTEXT = !/^(0|false|no|off)$/i.test(process.env.AGENT_EXTENDED_CONTEXT || '')
// Only a fallback for a DIRECT call that omits a model; the proxy normally passes
// one. Mirrors the proxy's dev default (spawnPicks in agent-routes.mjs) so the two
// paths agree — Sonnet: fast, capable, a fraction of Opus's limit weight. Pick
// Opus/Fable explicitly for hard tasks.
const DEFAULT_MODEL = `claude-sonnet-5${EXTENDED_CONTEXT ? '[1m]' : ''}`
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
// Sanity cap on a single prompt's text, delivered as one literal tmux
// send-keys line — not a real terminal paste, so no bracketed-paste chunking.
// Generous enough for a full pasted email or a multi-page brief; still guards
// against a multi-MB accidental paste getting typed keystroke-by-keystroke.
const PROMPT_MAX_CHARS = Number(process.env.AGENT_PROMPT_MAX_CHARS || 50000)
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
// Downloads dir (see listDownloads): caps on what one session may offer.
const MAX_DOWNLOAD_FILES = Number(process.env.AGENT_DOWNLOADS_MAX_FILES || 20)
const MAX_DOWNLOAD_BYTES = Number(process.env.AGENT_DOWNLOAD_MAX_BYTES || 100 * 1024 * 1024)
// After an interrupt we send Escape, then wait this long for Claude Code's TUI to
// stop the turn and return to an empty prompt before typing the added context (a
// send too soon races the still-streaming pane). Queued prompts are flushed on a
// timer: each tick, any session that has gone idle (no busy marker, no menu) gets
// its pending prompt delivered — true end-of-turn delivery, independent of the UI.
const INTERRUPT_SETTLE_MS = Number(process.env.AGENT_LOCAL_INTERRUPT_SETTLE_MS || 400)
const QUEUE_FLUSH_MS = Number(process.env.AGENT_LOCAL_QUEUE_FLUSH_MS || 3000)
// Kill-switch (0/false/no/off) for the mid-turn half: when off, EVERY queued
// prompt waits for a full idle again — the behaviour before boundary delivery,
// restorable with one env var and a restart. Default on.
const BOUNDARY_DELIVERY = !/^(0|false|no|off)$/i.test(process.env.AGENT_BOUNDARY_DELIVERY || '1')
// Verified choice-menu selection (see selectChoice below): the settle delay
// after each nav key before re-capturing the pane.
const SELECT_STEP_MS = Number(process.env.AGENT_SELECT_STEP_MS || 250)
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
// Whether that self-heal RE-ATTACHES (default) or only PARKS the orphans it finds
// as 'dormant' for the operator's Revive button. Off (0/false/off) is the older,
// strictly-manual behaviour — worth having on a box where an unattended resume
// burst is unwelcome. Even when on, the memory floor can still park the remainder.
const REATTACH = !/^(0|false|no|off)$/i.test(process.env.AGENT_LOCAL_REATTACH || '1')
// …and how many it may bring back unattended. Deliberately well under MAX_LIVE:
// nobody is watching this one, and every other one is a click away on the card.
const REATTACH_MAX = Number(process.env.AGENT_LOCAL_REATTACH_MAX || 4)
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
export const RESUME_CMD =
  process.env.AGENT_LOCAL_RESUME_CMD ||
  `IS_SANDBOX=1 env {claudeEnv}${CLAUDE} --model {model} --effort {effort} --mcp-config ${DEV_MCP_CONFIG} --strict-mcp-config --dangerously-skip-permissions --resume {sid}`
// Resume launch for the Atlas ORCHESTRATOR (the vault:'atlas' chat): like RESUME_CMD
// but re-attaches the agent-control MCP config + ATLAS_SESSION, so a revived
// orchestrator gets its spawn/prompt/kill tools back — a plain resume would bring the
// chat back DE-FANGED. Mirrors ATLAS_CONTROL_LAUNCH_CMD with `--resume` in place of
// `--session-id {sid} {task}` (the conversation is already in the transcript).
const ATLAS_CONTROL_RESUME_CMD =
  process.env.AGENT_ATLAS_RESUME_CMD ||
  `IS_SANDBOX=1 ATLAS_SESSION={atlasSession} env -u ANTHROPIC_API_KEY ${CLAUDE} --model {model} --effort {effort} --mcp-config ${CONTROL_MCP_CONFIG} --strict-mcp-config --dangerously-skip-permissions --resume {sid}`
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
// Waiting on an Atlas worker's turn (the close-time INGEST): poll interval + a
// start-grace for turns that finish between polls before we catch them busy.
const ATLAS_TURN_POLL_MS = Number(process.env.ATLAS_TURN_POLL_MS || 2500)
const ATLAS_TURN_GRACE_MS = Number(process.env.ATLAS_TURN_GRACE_MS || 12000)

// POSIX single-quote escaping — safe to embed in an `sh -lc` string.
function shquote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/* --- provider profiles: how a backend swap reaches the agent -------------- *
 * A profile (providers.mjs) changes only the ENVIRONMENT `claude` starts in, so
 * it lands in the two places a launch is assembled from — and nowhere else.
 *
 * 🔴 THE VALUES ARE SECRETS AND NEVER TOUCH A COMMAND LINE. A profile's env
 * travels BY FILE, exactly like a launch prompt (promptFileLaunch) and for a
 * sharper version of the same reason: the launch line is an argv, and an argv is
 * world-readable in `ps`. So is `tmux new-session -e NAME=value`, which was the
 * obvious implementation and is why it is not this one — the tmux SERVER a first
 * spawn starts keeps that argv for its whole life. Instead the API writes a
 * 0600 file the session's own shell SOURCES and deletes before `claude` starts.
 *
 * `&&` not `;`, matching promptFileLaunch: an unreadable env file STOPS the
 * launch instead of starting the agent on the default backend — the one failure
 * that would be invisible, because the agent works perfectly, just not where the
 * operator asked (and billed there).
 *
 * `claudeEnv` is the other half. Normally that slot holds
 * `-u ANTHROPIC_API_KEY ` — the subscription-auth guarantee documented above.
 * A profile OWNS the Anthropic env instead, so the slot empties and the profile's
 * own values stand: `-u` would strip exactly the `ANTHROPIC_API_KEY=` the
 * gateways need EXPLICITLY EMPTY (unset, Claude Code can fall back to
 * first-party auth). The empty default is prepended rather than required, so the
 * original guarantee — a stray key inherited from the tmux server's global env
 * can never reach an agent — survives a profile that does not mention the key.
 *
 * With no profile: `exports` is empty (no file is written at all) and
 * `claudeEnv` is the exact literal the templates used to hardcode, so the launch
 * line is byte-identical to a kit without profiles. The zero-profile invariant. */
export function providerLaunch(name) {
  const p = name ? resolveProvider(name) : null
  if (!p) return { exports: '', claudeEnv: '-u ANTHROPIC_API_KEY ' }
  const env = { ANTHROPIC_API_KEY: '', ...p.env }
  return {
    exports: Object.entries(env).map(([k, v]) => `export ${k}=${shquote(v)}\n`).join(''),
    claudeEnv: '',
  }
}

// Where a session's provider env is materialized — same shape as promptFile(),
// its own directory, and never inside a repo/worktree.
function providerEnvFile(id) {
  return path.join(STATE_DIR, 'env', `${String(id).replace(/[^A-Za-z0-9._-]/g, '_')}.env`)
}
/** Write this launch's env file and return the shell prefix that sources and
 *  removes it — `''` when there is no profile, so nothing is written and the
 *  launch line is untouched. Exported for the same reason knowledgeLaunch is:
 *  so the contract (0600, sourced, deleted, secrets nowhere in the argv) is
 *  driven end to end without going through git and a real `claude`. */
export function providerEnvPrefix(id, name) {
  const { exports } = providerLaunch(name)
  if (!exports) return ''
  const f = providerEnvFile(id)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, exports, { mode: 0o600 }) // operator-only, like an ssh key
  const q = shquote(f)
  return `. ${q} && rm -f ${q} && `
}
/* Drop an env file whose session never started (a failed `tmux new-session`) —
 * the shell that would have removed it never ran. Mirrors dropPromptFile. */
function dropProviderEnv(id) {
  try {
    fs.unlinkSync(providerEnvFile(id))
  } catch {
    /* never written (no profile), or already consumed */
  }
}

/**
 * Fill a launch template's placeholders — the ONE place any of them is
 * substituted, so a slot can never be left unfilled in one launch path and
 * filled in another (`{claudeEnv}` surviving into a real command line would make
 * `env` try to run a file called `{claudeEnv}`). Replacing a token a given
 * template does not carry is a no-op, which is why all four templates share this.
 * `{task}` is deliberately NOT here — it is filled by promptFileCommand, from a
 * file, and must never be inlined.
 *
 * Pure + exported so the composition is asserted without driving tmux
 * (api/test/provider-profiles.test.mjs).
 */
export function launchCommand(tmpl, { model, effort, sid, atlasSession, provider } = {}) {
  return tmpl
    .replace('{atlasSession}', shquote(atlasSession ?? ''))
    .replace('{claudeEnv}', providerLaunch(provider).claudeEnv)
    .replace('{model}', shquote(model || DEFAULT_MODEL))
    .replace('{effort}', shquote(effort || DEFAULT_EFFORT))
    .replace('{sid}', shquote(sid ?? ''))
}

// tmux's OWN limit on the command it is handed (`tmux new-session … sh -lc <cmd>`),
// measured: a 16,000-byte <cmd> is accepted, 17,000 fails with exactly `command
// too long` — i.e. tmux caps the whole command line at ~16 KiB, and this constant
// is the usable ceiling for the <cmd> part of it (the rest of the new-session
// line is ~100 B). It is NOT ARG_MAX (megabytes) — the kernel is nowhere near.
// Folding a retrieved evidence bundle (~26 KB) into that string fails EVERY
// spawn, silently: the agent starts anyway, unbriefed. So launch prompts travel
// by FILE (promptFileLaunch below) and never through tmux, and this constant is
// the ceiling the regression tests assert against.
export const TMUX_MAX_COMMAND_BYTES = 16000

// Where a session's launch prompt is materialized. Per-session (two concurrent
// spawns can never collide) and OUTSIDE every repo/worktree — a file dropped in
// the Atlas worktree would show up as untracked in the worker's own `git status`.
function promptFile(id) {
  return path.join(STATE_DIR, 'prompts', `${String(id).replace(/[^A-Za-z0-9._-]/g, '_')}.txt`)
}

/* Hand a launch prompt to `claude` WITHOUT putting it in the tmux command: write
 * it to this session's file, and build the command around its PATH. The shell
 * shape — and the byte-exactness / `&&` / `rm -f` reasoning behind it — lives in
 * prompt-file-launch.mjs, because the bridge executor builds the same command
 * around a file inside its container. */
function promptFileLaunch(cmd, id, prompt) {
  const file = promptFile(id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, promptFileBody(prompt))
  return promptFileCommand(cmd, file)
}

// Drop a prompt file whose session never started (a failed `tmux new-session`) —
// on the successful path the session's own shell removes it.
function dropPromptFile(id) {
  try {
    fs.rmSync(promptFile(id), { force: true })
  } catch {
    /* best effort */
  }
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
// Exported for the attachment round-trip test (api/test/agent-downloads.test.mjs).
export function saveImages(id, images) {
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
// The box-local checkout for a repo key — the same `path || WORKSPACE` a spawn
// uses — or null when this box doesn't have that repo (a bridge repo). What the
// default-branch resolver reads `origin/HEAD` from (ship-prompt.mjs).
export function repoPathFor(repo) {
  const target = loadRepos()[repo]
  return target ? target.path || WORKSPACE : null
}
// Whether the box can run Atlas workers at all: box-local execution is on AND the
// `atlas` vault is registered. Gates the paired-worker standby/ingest — including
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
// Exported so the REMOTE spawn path (agent-routes.mjs) writes to the same audit
// log a box-local spawn does — a bridge agent's spawn and how much evidence it
// left with must be reconstructable from one file, not two. The routes layer
// also appends the TEARDOWN-SCOPE trail here (who tore down whose child, and
// whether they used the `scope:"any"` override), for the same reason: one
// append-only file, not a second audit log beside it.
export function audit(entry) {
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
// `opts` (cwd / a longer timeout) is for the few calls that need it — everything
// else keeps the shared budget.
function run(argv, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      argv[0],
      argv.slice(1),
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, ...opts },
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

// Is a turn running? Two witnesses — the footer's `esc to interrupt` marker and
// the spinner line above the input box — because the footer is rendered to the
// pane width and drops that marker mid-turn. Shared with the bridge executor
// (one implementation, see pane-busy.mjs); re-exported here so this module
// stays the callers' single import, as before.
export { isBusy }

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
      now: scanNowMarker(lines),
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

// The OTHER end-of-run marker: CARD_PREAMBLE (box-local dev agents only) asks the
// agent to print `ATLAS:NOW <one line>` saying what the PROJECT is now about;
// scanNowMarker takes the LATEST one and we rewrite the matching card's `now:`
// (goal stays operator-owned). Applied OFF the poll path — the write goes through
// the serial vault commit queue (pull/rebase/commit/push takes about a second)
// and the GET must stay fast. `applyingCardNow` keeps one apply in flight per
// session; `s.cardNow` records the applied value so the same line is not
// re-applied on every poll — recorded even when the apply was a NO-OP (no bound
// project page, card already current), so a session can never loop on it.
const applyingCardNow = new Set()
async function applyCardNow(s, value) {
  try {
    const r = await updateProjectNow(s.repo, value)
    if (r && r.warning) console.error(`[agent-local] card "now" (${s.repo}):`, r.warning)
  } catch (e) {
    console.error('[agent-local] card "now" update failed:', e.message)
  } finally {
    s.cardNow = value
    applyingCardNow.delete(s.id)
    persist()
  }
}

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

/* Downloads — a per-session dir the agent can drop files into to offer the
 * operator a download (see DOWNLOADS_PREAMBLE in agent-routes.mjs), mirroring
 * the live-stats channel above but for files instead of numbers: no history to
 * accumulate, so the listing is just re-read fresh (cheap readdir + stat,
 * capped, dotfiles skipped) wherever a session's live fields are sampled.
 *
 * `String(id)` rather than a bare `id`: the prompt builders below substitute
 * `{downloadsDir}` unconditionally, and knowledgePrompt() is called without an
 * id by the pure prompt-contract tests — path.join would throw on undefined. */
function downloadsDir(id) {
  return path.join(STATE_DIR, 'downloads', String(id))
}
export function listDownloads(id) {
  let entries
  try {
    entries = fs.readdirSync(downloadsDir(id), { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue
    let st
    try {
      st = fs.statSync(path.join(downloadsDir(id), e.name))
    } catch {
      continue
    }
    files.push({ name: e.name, size: st.size, mtime: st.mtimeMs })
  }
  files.sort((a, b) => b.mtime - a.mtime)
  return files.slice(0, MAX_DOWNLOAD_FILES)
}
// Resolve one session's download by name for the GET route in agent-routes.mjs.
// `name` is the already URL-decoded query value (Express's query parser / the
// bridge's URLSearchParams both decode percent-encoding once — decoding again
// here would double-decode and mangle a filename with a literal `%`); it must be
// a plain basename (blocks `../` traversal and absolute paths) that appears in
// the CURRENT capped listing, and under the size cap. Returns
// { status, ok, path?, name?, error? }, the same shape the other route-backing
// functions (output/history/…) use.
export function downloadFile({ id, name }) {
  const s = registry.sessions[id]
  if (!s) return { status: 404, ok: false, error: 'no such session' }
  const decoded = String(name || '')
  if (!decoded || decoded === '.' || decoded === '..' || decoded !== path.basename(decoded))
    return { status: 400, ok: false, error: 'invalid name' }
  const file = listDownloads(id).find((f) => f.name === decoded)
  if (!file) return { status: 404, ok: false, error: 'no such download' }
  if (file.size > MAX_DOWNLOAD_BYTES) return { status: 413, ok: false, error: 'file too large' }
  return { status: 200, ok: true, path: path.join(downloadsDir(id), decoded), name: decoded }
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

function publicView(s, status, lastOutput, menuKind, transcript, appUp, menuChoice, downloads) {
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
    // …question/header/per-option `description`, and an `escape` flag on the
    // TUI's own "Type something."/"Chat about this" rows, all read straight off
    // the pane (menu.mjs's parseChoiceMenu). A menu this flow can't drive
    // reliably (multi-question/multiSelect, detected from the pane's own tab
    // row) sends no options at all, just `menuUnsupported` — the card falls back
    // to "use the terminal view" instead of misdriving it.
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
    // Which model-BACKEND this agent runs against — the profile NAME only, never
    // its env (see providers.mjs). Absent = the default Anthropic subscription,
    // which is every agent on a box with no profiles configured.
    ...(s.provider ? { provider: s.provider } : {}),
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
    // Files the agent has offered for download (listDownloads above): capped,
    // dotfiles skipped, newest first. Absent/empty → the card shows no chip.
    ...(downloads && downloads.length ? { downloads } : {}),
    // Agent-signaled ship state (ATLAS:READY-TO-SHIP / ATLAS:SHIPPED markers):
    // the card highlights the Ship button on 'ready' and swaps it for a check
    // on 'shipped'; `shipInfo` carries the SHIPPED detail (PR number + SHA).
    // `shipWarning` is the ship-time shared-checkout guard (checkSharedCheckout):
    // set only alongside 'ready', warn-only — the card shows a ⚠ beside Ship.
    // 'merged' OUTRANKS both markers: it is the repo's own verdict (sampleMerged
    // found the merge commit that landed this branch), so it also covers a PR
    // the orchestrator or the operator merged, and its `shipInfo` is the PR
    // number + merge SHA read off that commit rather than off the agent's reply.
    ...(s.shipState || s.shipMerged
      ? {
          shipState: s.shipMerged ? 'merged' : s.shipState,
          ...(s.shipMerged
            ? { shipInfo: mergedInfo(s.shipMerged) }
            : s.shipInfo
              ? { shipInfo: s.shipInfo }
              : {}),
          ...(s.shipWarning && !s.shipMerged ? { shipWarning: s.shipWarning } : {}),
        }
      : {}),
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

// One `git status` on the repo's SHARED checkout when a session flips to
// READY-TO-SHIP (the decision itself is pure — shared-checkout.mjs). The path
// comes from the session's repo config (`s.path`), never a hardcoded one.
// Fire-and-forget so the poll stays fast: the warning surfaces on the next tick.
// Dev sessions only — a knowledge chat's `path` is its vault.
async function checkSharedCheckout(s) {
  if (!s.path || s.kind === 'knowledge') return
  const w = sharedCheckoutWarning(s.path, await run(['git', '-C', s.path, 'status', '--porcelain', '-b']))
  if ((s.shipWarning || '') === (w || '')) return
  if (w) s.shipWarning = w
  else delete s.shipWarning
  persist()
}

// ── Merged-branch detection (merged-check.mjs is the pure core) ─────────────
// The agent's own ATLAS markers only ever tell us what the AGENT did, so a PR
// merged by the Atlas orchestrator or by the operator on github.com left the
// card stuck on `ready`. Ask the repo instead: periodically, for every dev
// session whose branch hasn't been found merged yet, look for the merge commit
// that landed it. The verdict is PERSISTED on the session (`s.shipMerged`), so
// it survives cleanup_agent force-deleting the branch, and it is TERMINAL — a
// merged session is dropped from the candidate set (only a NEW ship marker,
// i.e. the agent taking on fresh work, clears it; see the poll in listSessions).
//
// Freshness: this is the only thing here that touches the network, and it
// fetches ONE ref (the default branch) per repo per pass, only when that repo
// still has an unmerged candidate — i.e. nothing at all once the fleet is idle
// or fully merged. Default cadence is 5 min (AGENT_MERGED_CHECK_MS).
const MERGED_CHECK_MS = Number(process.env.AGENT_MERGED_CHECK_MS || 5 * 60 * 1000)
let mergedCheckedAt = 0
let checkingMerged = false

// A session whose merged-ness is still worth a look: a dev agent with a branch,
// in a repo checked out on this box, not already found merged.
const mergeCandidate = (s) =>
  (s.kind || 'dev') === 'dev' && !!s.branch && !!s.path && !s.shipMerged && s.status !== 'error'

// `origin/<default>` for this checkout — read from the remote HEAD, never assumed.
async function defaultRemoteRef(repoPath) {
  const r = await run(['git', '-C', repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const ref = r.ok ? r.stdout.trim() : ''
  return ref.startsWith('origin/') ? ref : ''
}

async function sampleMerged() {
  const now = Date.now()
  if (checkingMerged || now - mergedCheckedAt < MERGED_CHECK_MS) return
  mergedCheckedAt = now
  checkingMerged = true
  let changed = false
  try {
    const byPath = new Map()
    for (const s of Object.values(registry.sessions)) {
      if (!mergeCandidate(s)) continue
      if (!byPath.has(s.path)) byPath.set(s.path, [])
      byPath.get(s.path).push(s)
    }
    for (const [repoPath, list] of byPath) {
      const ref = await defaultRemoteRef(repoPath)
      if (!ref) continue
      // Refresh ONLY that one remote-tracking ref — an explicit refspec keeps the
      // ref lock narrow, so this never contends with a deploy pull the way a bare
      // `git fetch` would.
      const head = ref.slice('origin/'.length)
      await run(['git', '-C', repoPath, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${head}:refs/remotes/${ref}`])
      for (const s of list) {
        const tip = await run(['git', '-C', repoPath, 'rev-parse', '--verify', `${s.branch}^{commit}`])
        if (!tip.ok) continue // branch gone (cleaned up, or never created) — say nothing
        const log = await run([
          'git', '-C', repoPath, 'log', '--ancestry-path', '--merges', MERGE_LOG_FORMAT,
          `${tip.stdout.trim()}..${ref}`,
        ])
        const v = log.ok ? mergedVerdict(tip.stdout.trim(), log.stdout) : null
        if (!v) continue
        s.shipMerged = v
        changed = true
        audit({ action: 'merged', id: s.id, repo: s.repo, branch: s.branch, pr: v.pr, sha: v.sha, ok: true })
      }
    }
  } finally {
    checkingMerged = false
    if (changed) persist()
  }
}

// A merge is a network round-trip to GitHub, not a local git call — the shared
// 15 s exec budget is too tight for it.
const MERGE_TIMEOUT_MS = Number(process.env.AGENT_MERGE_TIMEOUT_MS || 60000)
// `mergeStateStatus` reads UNKNOWN while GitHub is still computing mergeability
// after a push — transient, not a failure, so poll instead of refusing on the
// first look. Worst case ~3 views + 2 waits, well inside MERGE_TIMEOUT_MS.
const PREFLIGHT_TRIES = Number(process.env.AGENT_MERGE_PREFLIGHT_TRIES || 3)
const PREFLIGHT_DELAY_MS = Number(process.env.AGENT_MERGE_PREFLIGHT_DELAY_MS || 1500)
const PR_VIEW_FIELDS = 'number,state,mergeStateStatus,mergeable,statusCheckRollup,baseRefName'

/** GitHub's view of the PR for this branch — null when there is no open PR. */
async function prView(s) {
  const r = await run(['gh', 'pr', 'view', s.branch, '--json', PR_VIEW_FIELDS], {
    cwd: s.path,
    timeout: MERGE_TIMEOUT_MS,
  })
  if (!r.ok) return null // `gh` exits non-zero with "no pull requests found for branch"
  try {
    return JSON.parse(r.stdout)
  } catch {
    return null
  }
}

/**
 * Does the PR branch contain the CURRENT tip of its base? That is the freshness
 * question `mergeStateStatus` can only answer on a repo whose protection REQUIRES
 * up-to-date branches — on an unprotected repo it reports CLEAN for a branch built
 * on an old base, so ask git.
 *
 * Both sides are read from origin (the merge lands what GitHub has, not what this
 * checkout happens to hold), refreshed with explicit refspecs so the ref lock
 * stays narrow and never contends with a deploy pull — same discipline as
 * sampleMerged(). Resolving both to SHAs first means a failing `--is-ancestor` is
 * the ancestry ANSWER and not a bad-ref error.
 *
 * @returns true (fresh) / false (behind) / null (undeterminable — never refuse)
 */
async function branchIsFresh(s, base) {
  if (!base) return null
  const f = await run([
    'git', '-C', s.path, 'fetch', '--quiet', '--no-tags', 'origin',
    `+refs/heads/${base}:refs/remotes/origin/${base}`,
    `+refs/heads/${s.branch}:refs/remotes/origin/${s.branch}`,
  ])
  if (!f.ok) return null
  const sha = async (ref) => {
    const r = await run(['git', '-C', s.path, 'rev-parse', '--verify', `refs/remotes/origin/${ref}^{commit}`])
    return r.ok ? r.stdout.trim() : ''
  }
  const [baseSha, headSha] = [await sha(base), await sha(s.branch)]
  if (!baseSha || !headSha) return null
  return (await run(['git', '-C', s.path, 'merge-base', '--is-ancestor', baseSha, headSha])).ok
}

/** Ask GitHub + git whether this PR may be merged. Never merges anything. */
async function preflight(s) {
  let pr = null
  for (let i = 1; i <= PREFLIGHT_TRIES; i++) {
    pr = await prView(s)
    if (!pr || String(pr.mergeStateStatus || '').toUpperCase() !== 'UNKNOWN') break
    if (i < PREFLIGHT_TRIES) await sleep(PREFLIGHT_DELAY_MS)
  }
  const fresh = pr && String(pr.state || 'OPEN').toUpperCase() === 'OPEN'
    ? await branchIsFresh(s, pr.baseRefName)
    : null
  return preflightVerdict({ pr, fresh, branch: s.branch, tries: PREFLIGHT_TRIES })
}

/**
 * Merge one box-local dev agent's PR — `gh pr merge <branch> --merge`, run in the
 * repo checkout the session's worktree belongs to. Exactly what the ship protocol
 * (and an orchestrator's own Bash) runs by hand.
 *
 * Doing it HERE is the point: the caller of this route can be recorded as the
 * merger (agent-routes' merge claim → the fleet note it would otherwise get told
 * about its own action), which a raw `gh pr merge` in an agent's terminal can
 * never be. GitHub can't tell us who merged — every merge goes through the same
 * token — so the claim has to be a side effect of the merge action itself.
 *
 * A server-side PRE-FLIGHT fronts it (merge-preflight.mjs): stale / conflicted /
 * blocked / red / still-running-checks / no-open-PR are refused with the state
 * named, because this is the one ship path that otherwise revalidates nothing.
 * `force: true` skips it — the operator sometimes knows better — but nothing
 * else about a successful merge changes, the merge claim included.
 */
export async function mergePr({ id, force = false }) {
  const s = registry.sessions[id]
  if (!s) return { status: 404, ok: false, error: 'no such session' }
  if ((s.kind || 'dev') !== 'dev' || !s.branch || !s.path) {
    return { status: 400, ok: false, error: 'not a dev agent with a branch' }
  }
  if (!force) {
    const v = await preflight(s)
    if (!v.ok) {
      audit({ action: 'merge-pr', id: s.id, repo: s.repo, branch: s.branch, ok: false, preflight: v.state, error: v.error })
      return { status: 409, ok: false, error: v.error, preflight: v.state }
    }
  }
  const r = await run(['gh', 'pr', 'merge', s.branch, '--merge'], { cwd: s.path, timeout: MERGE_TIMEOUT_MS })
  const detail = ((r.stdout || '') + (r.stderr || '')).trim().slice(0, 500)
  audit({ action: 'merge-pr', id: s.id, repo: s.repo, branch: s.branch, ok: r.ok, ...(force ? { force: true } : {}), ...(r.ok ? {} : { error: detail }) })
  if (!r.ok) return { status: 502, ok: false, error: detail || 'gh pr merge failed' }
  return { status: 200, ok: true, branch: s.branch, output: detail }
}

export async function listSessions() {
  const out = []
  let changed = false
  // One probe of the shared box-local app slot per poll — its liveness is the
  // same for every dev session (single port), so the card knows whether to offer
  // the side-by-side app pane.
  const appUp = await probeTcp(APP_PORT)
  for (const s of Object.values(registry.sessions)) {
    // Paired Atlas workers (the close-time ingest attached to a BOX dev agent) surface on
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
      // Ship-time guard: the moment the agent declares itself ready, look at the
      // repo's SHARED checkout (the one the live services run from) and warn if
      // it isn't clean at its upstream — the tell for an agent that worked there
      // instead of in its worktree. Warn only; see shared-checkout.mjs. Any other
      // transition (→ shipped, or back) drops a stale warning.
      if (ship.state === 'ready') checkSharedCheckout(s)
      else delete s.shipWarning
      // A NEW marker means the agent moved on (re-tasked after its PR landed),
      // so the old merged verdict no longer describes the branch — drop it and
      // let sampleMerged decide again.
      delete s.shipMerged
    }
    // End-of-run "Now" signal → rewrite the project card's `now:`. Fire-and-
    // forget so the poll stays fast; guarded so each value applies once. DEV
    // agents only: a knowledge chat's `repo` is the vault key and an Atlas
    // worker's is the vault too — neither has a project card to speak for.
    const cardNow = (s.kind || 'dev') === 'dev' && transcript && transcript.now
    if (cardNow && cardNow !== s.cardNow && !applyingCardNow.has(s.id)) {
      applyingCardNow.add(s.id)
      applyCardNow(s, cardNow)
    }
    out.push(
      publicView(s, status, tail || s.lastSeen || '', menuKind, transcript, appUp, menuChoice, listDownloads(s.id)),
    )
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
  // The rule itself lives in agent-capacity.mjs — one implementation, shared with
  // the remote gate in agent-routes.mjs and the bridge's own gate, so the box that
  // has been protected all along and the bridge boxes that were not can never
  // drift apart. The WORDING stays local: these two strings predate the sharing
  // and this path is unchanged, deliberately, down to the message.
  const v = capacityVerdict({
    live: await liveAgentCount(),
    maxAgents: MAX_LIVE,
    mem: readMemStatus(),
    floorMb: REVIVE_MEM_FLOOR_MB,
    perAgentMb: REVIVE_MEM_PER_AGENT_MB,
    // ⚠️ The box-local reading does NOT charge swap against availability, which
    // the remote gate does (see agent-capacity.mjs). Not an oversight: this path
    // is the one that must stay behaviourally identical, and a control-plane box
    // may sit permanently some way into swap by design. Charging it here is a
    // separate, measurable change — not a side effect of capping the bridges.
    chargeSwap: false,
  })
  if (v.reason === 'ceiling')
    return {
      status: 503,
      ok: false,
      error: `box at agent capacity (${v.live}/${v.maxAgents} live) — close one or raise AGENT_LOCAL_MAX_CONCURRENT`,
    }
  if (v.reason === 'memory')
    return {
      status: 503,
      ok: false,
      error: `box low on memory (${v.availMb} MB free) — close an agent first, then spawn`,
    }
  return null
}
// Free RAM right now, in MB (MemAvailable — accounts for reclaimable cache). Falls
// back to os.freemem() off Linux (dev only); Infinity if nothing is readable, so a
// missing /proc never blocks a revive.
function availMemMb() {
  return readMemStatus().availMb
}
// Room to launch one more agent? Returns {avail, ok} — ok once free RAM clears the
// floor + one-agent headroom (REVIVE_MEM_* above). Same shared rule as atCapacity.
function memHeadroom() {
  const v = capacityVerdict({
    live: 0, // memory only — the count ceiling is atCapacity's business, not a revive's
    maxAgents: Infinity,
    mem: readMemStatus(),
    floorMb: REVIVE_MEM_FLOOR_MB,
    perAgentMb: REVIVE_MEM_PER_AGENT_MB,
    chargeSwap: false,
  })
  return { avail: v.availMb, ok: v.ok }
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
// revivable. The boot self-heal re-attaches what fits and parks the rest here
// (see reconcileOrphans) — the card then shows those 'dormant' with a Revive
// button, one at a time or the memory-gated "Revive all".
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
/** Which orphans this boot re-attaches, and which it leaves parked: newest first
 *  (the session someone was most likely mid-conversation with is worth the scarce
 *  slot), capped at `max`. Everything past the cap stays dormant — a FALLBACK,
 *  never a loss, so an over-cap fleet still comes back one Revive click at a
 *  time. Pure + exported so the split is unit-tested without tmux
 *  (test/agent-boot-reattach.test.mjs). */
export function planReattach(candidates, { max = 0 } = {}) {
  const cap = Math.max(0, max)
  const ordered = [...candidates].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
  return { reattach: ordered.slice(0, cap), park: ordered.slice(cap) }
}

/**
 * Re-attach the planned set, stopping at the memory floor.
 *
 * The gate is checked BEFORE EVERY launch, and the moment it refuses the ENTIRE
 * remainder parks — the exact opposite of retrying, because the box this runs on
 * is RAM-bound and a resume burst is what OOMs it. So a low-memory box degrades
 * to precisely the old behaviour (everything dormant, the Revive button as the
 * fallback) instead of spiralling.
 *
 * `memOk` and `launch` are injected so the whole decision — cap, stagger,
 * refusal remainder — is testable with no tmux and no real memory pressure.
 * Returns { attached, park }; the caller parks and persists.
 */
export async function runReattach(candidates, { max, memOk, launch, stagger = 0 }) {
  const { reattach, park } = planReattach(candidates, { max })
  const attached = []
  for (let i = 0; i < reattach.length; i++) {
    if (!memOk()) {
      park.push(...reattach.slice(i))
      break
    }
    if (await launch(reattach[i])) {
      attached.push(reattach[i])
      if (stagger && i < reattach.length - 1) await sleep(stagger)
    } else {
      park.push(reattach[i]) // the resume itself failed — dormant, so it can be retried
    }
  }
  return { attached, park }
}

// Boot self-heal: PARK every session a tmux-server death orphaned — present in
// BOOT_ALIVE (alive when we loaded state.json) but with no live tmux — and then
// RE-ATTACH the newest few. Re-attaching is what makes a restart (a Redeploy, a
// reboot) invisible to a running fleet; parking is what it degrades to.
//
// Park FIRST, and persist that, before any resume: the re-attach loop sleeps
// between launches, and a crash inside that window must leave every session it
// hasn't reached 'dormant' with a working Revive button, never in limbo.
//
// Bounded three ways, because an unattended resume burst on a RAM-bound box is
// the failure this must not cause (it is why auto-resume was dropped for parking
// in the first place): capped at REATTACH_MAX and at the room left under
// MAX_LIVE, staggered by REVIVE_STAGGER_MS, and gated on the SAME memory floor
// the Revive button uses, re-read before every launch.
//
// The resume itself goes through launchResume — the one place that decides which
// MCP profile a session gets back (the Atlas orchestrator resumes WITH its
// agent-control config; everything else resumes on the knowledge-only profile,
// which dev.mcp.json and worker.mcp.json both are) — so boot re-attach and a
// manual revive can never drift apart.
//
// Kill-switches: AGENT_LOCAL_RECONCILE=0/off (no self-heal at all),
// AGENT_LOCAL_REATTACH=0/off (find + park, never resume). NOTE a `serve.sh
// restart` is session-scoped, so agent tmux SURVIVES it — this only finds
// orphans after a true server death.
async function reconcileOrphans() {
  if (!RECONCILE) return
  const live = liveSessionsFromLs(await run(['tmux', 'ls', '-F', '#{session_name}']))
  // tmux ls failed for some reason OTHER than a dead server — inconclusive. Bail
  // rather than mass-park live agents on a transient glitch (Express restarts on
  // every deploy, so this path runs each time and a false-orphan is costly).
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
  if (!REATTACH) return
  // Room left under the ceiling, counting the agents that DID survive.
  const stillLive = Object.values(registry.sessions).filter((s) => live.has(s.tmux)).length
  const { attached, park } = await runReattach(candidates, {
    max: Math.min(REATTACH_MAX, Math.max(0, MAX_LIVE - stillLive)),
    memOk: () => memHeadroom().ok,
    launch: async (s) => (await launchResume(s)).ok, // sets status back to 'running'
    stagger: REVIVE_STAGGER_MS,
  })
  for (const s of attached) audit({ action: 'reattach', id: s.id, repo: s.repo, kind: s.kind || 'dev', ok: true })
  // `park` is already dormant from the pass above — nothing to undo, which is the
  // point of parking first. Just record what the Revive button is left holding.
  if (park.length)
    audit({ action: 'reattach-held', attached: attached.length, held: park.length, floorMb: REVIVE_MEM_FLOOR_MB, availMb: availMemMb(), ok: true })
  if (attached.length) persist()
}
// Relaunch a session's Claude session in a fresh tmux under its expected name —
// the shared core of revive()/reviveAll() (the launch the old auto-reconciler ran):
// `claude --resume` in the worktree, repo pre-trusted, the resume menu auto-
// confirmed. Clears the terminal stamps so the next poll renders it live. Returns
// the run() result ({ ok, stderr }).
async function launchResume(s) {
  const sid = resumeId(s)
  if (!sid) return { ok: false, stderr: 'no resumable Claude session found' }
  const noClaude = claudeUnavailable()
  if (noClaude) return { ok: false, stderr: noClaude.error }
  // The Atlas orchestrator (vault:'atlas' chat) must resume WITH its agent-control
  // MCP config or it loses its spawn/prompt/kill steering tools; all else resumes plain.
  const tmpl = s.vault === 'atlas' ? ATLAS_CONTROL_RESUME_CMD : RESUME_CMD
  // A session pinned to a PROVIDER profile must come back on the SAME backend —
  // resuming a DeepSeek session onto Anthropic (or onto a profile the operator has
  // since edited away) would switch model mid-conversation, silently. Refuse with
  // the reason instead; the profile is one JSON entry away from existing again.
  if (s.provider && !resolveProvider(s.provider))
    return { ok: false, stderr: `provider profile "${s.provider}" is no longer configured` }
  // Without this a revived agent silently loses `agent-msg` — the wrapper lives
  // on PATH, and PATH is set by the launch line, so both paths must set it.
  ensureMsgWrapper()
  const launch = providerEnvPrefix(s.id, s.provider) + msgEnv(s) + launchCommand(tmpl, {
    atlasSession: s.id, // no-op token on the plain template
    model: s.model, effort: s.effort, sid, provider: s.provider,
  })
  ensureRepoTrusted(s.worktree)
  const ns = await run(['tmux', 'new-session', '-d', '-s', s.tmux, '-c', s.worktree, 'sh', '-lc', launch])
  if (!ns.ok) {
    dropProviderEnv(s.id) // the session's shell never ran, so it never removed it
    return ns
  }
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

/* The opening prompt a dev agent is launched with. Pure (path math only) and
 * exported so the contract is testable without driving tmux
 * (api/test/atlas-evidence-spawn.test.mjs): `context` is the pre-formed Atlas
 * evidence block, injected BETWEEN the standing preamble and the task — and with
 * none the prompt must stay BYTE-IDENTICAL to what an unbriefed spawn has always
 * had. `{statsFile}`/`{downloadsDir}`/`{worktree}` are this session's own paths
 * (only the executor knows the id); attached-file paths fold into the task text
 * as a single-line tail, the same mechanism a follow-up prompt's images use. */
export function devPrompt({ id, task, repo, preamble, context, worktree, imagePaths = [] }) {
  const taskBody = withImages(task, imagePaths)
  if (!preamble) return taskBody
  const head = injectApp(
    preamble
      .replaceAll('{statsFile}', statsFile(id))
      .replaceAll('{downloadsDir}', downloadsDir(id))
      .replaceAll('{worktree}', worktree),
    repo,
    id,
  )
  return `${head}${context ? `\n\n${context}` : ''}\n\n---\n# Your task\n${taskBody}`
}

/* --- agent↔agent message channel ------------------------------------ *
 * Every box-local dev agent is launched with a PER-SESSION token in its env and
 * a tiny `agent-msg` wrapper on its PATH. The token authenticates
 * POST /api/agents/message as EXACTLY that session — deliberately NOT the global
 * DASHBOARD_BEARER_TOKEN, which anyone reading the agent's env could then use to
 * spawn/kill/prompt the whole fleet. It is only ever valid while the session is
 * in the registry (agentByToken looks it up live), so killing the agent revokes
 * it. See agent-messages.mjs for the bus log and agent-routes.mjs for the route.
 * ------------------------------------------------------------------ */
const MSG_BIN_DIR = path.join(STATE_DIR, 'bin')
const MSG_WRAPPER = path.join(MSG_BIN_DIR, 'agent-msg')
const MSG_API = process.env.AGENT_MESSAGE_API || 'http://127.0.0.1:3001'
function ensureMsgWrapper() {
  try {
    fs.mkdirSync(MSG_BIN_DIR, { recursive: true })
    let have = ''
    try {
      have = fs.readFileSync(MSG_WRAPPER, 'utf-8')
    } catch {
      /* not written yet */
    }
    if (have !== MSG_WRAPPER_SRC) fs.writeFileSync(MSG_WRAPPER, MSG_WRAPPER_SRC, { mode: 0o755 })
    fs.chmodSync(MSG_WRAPPER, 0o755)
  } catch (e) {
    console.error('[agent-local] agent-msg wrapper write failed:', e.message)
  }
}
// Env assignments prefixed onto a session's launch command (both the fresh spawn
// and the resume path) — the scoped token, this session's own id, and the wrapper
// dir on PATH. Empty for sessions with no token (knowledge chats, old sessions).
function msgEnv(s) {
  if (!s.msgToken) return ''
  return `ATLAS_AGENT_ID=${shquote(s.id)} ATLAS_AGENT_TOKEN=${shquote(s.msgToken)} ATLAS_API=${shquote(MSG_API)} PATH=${shquote(MSG_BIN_DIR)}:$PATH `
}
/* No usable `claude` ⇒ refuse the launch WITH the reason, rather than opening a
 * tmux session that dies on ENOENT and reads as "the agent just never started".
 * Cheap (the resolution is memoized) and returns the routes' error shape. */
function claudeUnavailable() {
  const info = claudeBinInfo()
  return info.ok ? null : { status: 503, ok: false, error: `claude CLI unavailable: ${info.error}` }
}

// Resolve a scoped message token to its session. Linear over the live registry
// (a handful of sessions) and only ever matches a session that still exists —
// which IS the revocation mechanism.
export function agentByToken(token) {
  if (!token || typeof token !== 'string') return null
  for (const s of Object.values(registry.sessions)) {
    if (s.msgToken && s.msgToken === token) return describeSession(s.id)
  }
  return null
}

export async function spawn({ task, repo, preamble, model, effort, context, images, provider }) {
  if (!task || typeof task !== 'string') return { status: 400, ok: false, error: 'task required' }
  const repos = loadRepos()
  const target = repos[repo]
  if (!target) return { status: 400, ok: false, error: `unknown box repo "${repo}"` }
  // The route validates this too; re-checked here because spawn() is also called
  // directly (the scheduler replaying a job), and launching against a profile that
  // no longer resolves would quietly run the agent on the default backend.
  if (provider && !resolveProvider(provider))
    return { status: 400, ok: false, error: `unknown provider profile "${provider}"` }
  const noClaude = claudeUnavailable()
  if (noClaude) return noClaude
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
    // The profile NAME only — its env is resolved per launch and never persisted
    // (state.json is a plain file; an API key does not belong in it).
    ...(provider ? { provider } : {}),
    // Scoped agent↔agent message token (see the message-channel block above).
    // Dev agents only — they're the ones that need to talk to a parent/sibling.
    msgToken: randomBytes(24).toString('hex'),
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

  // The slug/branch derive from `task` only; the preamble and the retrieved Atlas
  // evidence (`context`) go into the prompt the agent actually receives — see
  // devPrompt — so branch names stay clean. The stats dir is pre-created so a
  // bare `>` redirect from the agent's first background script just works;
  // `{downloadsDir}` (DOWNLOADS_PREAMBLE) is this session's download dir,
  // pre-created the same way so a `cp` into it works on the first turn.
  fs.mkdirSync(path.join(STATE_DIR, 'stats'), { recursive: true })
  fs.mkdirSync(downloadsDir(id), { recursive: true })
  const prompt = devPrompt({ id, task, repo, preamble, context, worktree, imagePaths })
  // Prompt by FILE, not in the tmux command (promptFileLaunch): the retrieved
  // Atlas evidence makes this prompt tens of KB, far past tmux's ~16 KB command
  // ceiling — and that failure is silent-by-shape.
  ensureMsgWrapper() // `agent-msg` on the agent's PATH (message channel above)
  const launch = promptFileLaunch(
    providerEnvPrefix(id, provider) + msgEnv(session) + launchCommand(LAUNCH_CMD, { model, effort, provider }),
    id,
    prompt,
  )
  ensureRepoTrusted(repoPath) // so the worktree launch skips Claude Code's trust dialog
  const ns = await run([
    'tmux', 'new-session', '-d', '-s', tmux, '-c', worktree, 'sh', '-lc', launch,
  ])
  if (!ns.ok) {
    dropPromptFile(id) // the session's shell never ran, so it never removed it
    dropProviderEnv(id) // …nor the env file beside it
    session.status = 'error'
    session.error = (ns.stderr || 'tmux new-session failed').slice(0, 500)
    registry.sessions[id] = session
    persist()
    audit({ action: 'spawn', id, repo, ok: false, error: session.error })
    return { status: 502, ok: false, error: session.error }
  }

  registry.sessions[id] = session
  persist()
  audit({ action: 'spawn', id, repo, branch, model: model || DEFAULT_MODEL, effort: effort || DEFAULT_EFFORT, ...(provider ? { provider } : {}), images: imagePaths.length, ok: true })
  return { status: 200, ok: true, id }
}

/* The opening prompt a knowledge chat is launched with. Pure and exported so the
 * contract is testable without driving tmux (api/test/atlas-chat-evidence.test.mjs,
 * api/test/agent-downloads.test.mjs): with no evidence and no attachments it must
 * stay byte-identical to what it has always been, and with attachments the saved
 * paths must reach the first turn so the chat can Read them.
 *
 * `context` is the pre-formed Atlas evidence block (chatEvidence), placed between
 * the standing preamble and the question. The question keeps its own
 * `# Operator question` heading BELOW the evidence, so what the operator actually
 * asked can never read as part of the briefing. `{downloadsDir}` in the preamble
 * (DOWNLOADS_PREAMBLE) becomes this chat's own download dir. */
export function knowledgePrompt({ id, question, preamble, context, imagePaths = [] }) {
  // Attached-file paths fold into the question text (a single-line tail) so the
  // chat reads them on its first turn — same mechanism as a dev spawn's.
  const body = withImages(question, imagePaths)
  return preamble
    ? `${preamble.replaceAll('{downloadsDir}', downloadsDir(id))}${context ? `\n\n${context}` : ''}\n\n---\n# Operator question\n${body}`
    : body
}

/* A knowledge chat's launch line. Exported for the same reason atlasWorkerLaunch
 * is: so the SIZE contract is testable without driving tmux
 * (api/test/atlas-chat-evidence.test.mjs). The prompt travels by FILE
 * (promptFileLaunch) and the command carries only its path — which is what keeps
 * a chat prompt that now runs tens of KB (evidence + preamble) under tmux's
 * ~16 KB command limit. The only side effect is writing the session's prompt
 * file. */
export function knowledgeLaunch({ id, sid, vaultKey, model, effort, prompt }) {
  return promptFileLaunch(
    // No `provider` here: profiles are a DEV-agent feature. A knowledge chat —
    // the Atlas orchestrator especially — stays on the subscription backend.
    launchCommand(vaultKey === 'atlas' ? ATLAS_CONTROL_LAUNCH_CMD : KNOWLEDGE_LAUNCH_CMD, {
      atlasSession: id, // no-op token for the non-atlas template
      model,
      effort,
      sid,
    }),
    id,
    prompt,
  )
}

/* Knowledge agent: an interactive vault chat (a vault chat).
 * Same tmux + registry contract as a dev agent, but it lives IN the work vault
 * (cwd = vault root, so the vault's own CLAUDE.md conventions auto-load) with
 * no git worktree and no branch — the vault is not branch-isolated; the
 * preamble's add-and-link + pull-rebase-then-commit rules are the boundary.
 * Gated on the same opt-in as the rest of box-local execution (the repo
 * allowlist file): no allowlist → no execution on this box, of either kind. */
export async function spawnKnowledge({ question, preamble, model, effort, vault, images }) {
  if (!question || typeof question !== 'string') return { status: 400, ok: false, error: 'question required' }
  if (!localRepoKeys().length) return { status: 503, ok: false, error: 'box-local executor disabled' }
  // `vault` (a key) is optional → the default vault, so a plain Knowledge Base
  // chat is unchanged; the Atlas tab passes vault:'atlas' to chat over the Atlas.
  const vlt = resolveVault(vault)
  if (!vlt) return { status: vault ? 404 : 503, ok: false, error: vault ? `unknown vault "${vault}"` : 'no vault configured' }
  const noClaude = claudeUnavailable()
  if (noClaude) return noClaude
  const capErr = await atCapacity()
  if (capErr) return capErr

  const slug = slugify(question)
  if (!slug) return { status: 400, ok: false, error: 'question has no usable slug' }
  // Scope the id by vault so an Atlas chat reads as `kb-atlas-…` and can't collide
  // with a work-vault `kb-…` of the same slug.
  const base = vlt.key === defaultVaultKey() ? `kb-${slug}` : `kb-${vlt.key}-${slug}`
  let id = base
  for (let n = 2; registry.sessions[id]; n++) id = `${base}-${n}`

  // Save any attached files to this session's upload dir — AFTER the id is
  // resolved (saveImages keys the dir by it) and BEFORE anything is registered or
  // launched, so a bad attachment fails fast with nothing left behind. Their
  // paths fold into the opening question below, exactly as spawn() does.
  let imagePaths = []
  if (Array.isArray(images) && images.length) {
    try {
      imagePaths = saveImages(id, images)
    } catch (e) {
      return { status: 400, ok: false, error: e.message }
    }
  }

  const tmux = `agentbox-${id}`
  const claudeSessionId = randomUUID()
  const session = {
    id, kind: 'knowledge', task: question, repo: 'vault', vault: vlt.key,
    path: vlt.path, worktree: vlt.path, tmux, claudeSessionId,
    model: model || DEFAULT_MODEL, effort: effort || DEFAULT_EFFORT,
    status: 'running', startedAt: nowIso(), lc: initLifecycle(LC.SPAWNED),
  }

  // `{downloadsDir}` (DOWNLOADS_PREAMBLE) is this chat's download dir, same
  // contract as a dev agent's — pre-created so the agent can write into it right
  // away.
  fs.mkdirSync(downloadsDir(id), { recursive: true })
  // The retrieved Atlas candidate set, folded into the chat's FIRST turn — the
  // same retrieval a dev spawn gets (chatEvidence → atlasEvidence). '' on any
  // failure and on every non-atlas vault, and then this prompt is byte-identical
  // to the one chats have always had. Resolved key, not the caller's `vault` —
  // the Atlas IS the default vault, so a chat spawned without one is still an
  // Atlas chat.
  const context = await chatEvidence({ vaultKey: vlt.key, question, id })
  const prompt = knowledgePrompt({ id, question, preamble, context, imagePaths })
  const launch = knowledgeLaunch({
    id, sid: claudeSessionId, vaultKey: vlt.key,
    model: model || DEFAULT_MODEL, effort: effort || DEFAULT_EFFORT, prompt,
  })
  ensureRepoTrusted(vlt.path) // so the launch skips Claude Code's trust dialog
  const ns = await run([
    'tmux', 'new-session', '-d', '-s', tmux, '-c', vlt.path, 'sh', '-lc', launch,
  ])
  if (!ns.ok) {
    dropPromptFile(id) // the session's shell never ran, so it never removed it
    session.status = 'error'
    session.error = (ns.stderr || 'tmux new-session failed').slice(0, 500)
    registry.sessions[id] = session
    persist()
    audit({ action: 'spawn', kind: 'knowledge', id, vault: vlt.key, ok: false, error: session.error })
    return { status: 502, ok: false, error: session.error }
  }

  registry.sessions[id] = session
  persist()
  audit({ action: 'spawn', kind: 'knowledge', id, vault: vlt.key, model: model || DEFAULT_MODEL, effort: effort || DEFAULT_EFFORT, images: imagePaths.length, ok: true })
  return { status: 200, ok: true, id }
}

/**
 * The Atlas evidence block for a dev agent's opening prompt — the retrieval that
 * replaced a synthesized brief.
 *
 * Measured on the design this replaces: of the sessions that attempted an LLM
 * brief, 84% never got one (the synthesis on top of this same retrieval took
 * ~28 s and timed out at 45 s), and the late ones landed 3-44 min in — after the
 * work they were meant to inform. The retrieval itself is neither slow nor
 * flaky: sub-second over a whole vault. So the synthesis goes and the evidence
 * stays.
 *
 * NEVER throws and never blocks a spawn on the Atlas: any failure — retrieval
 * error, no atlas configured, no project page for the repo, unknown repo — yields
 * '' and the agent launches exactly as it would on a box with no Atlas at all.
 * `root` defaults to the live atlas checkout and is injectable for tests.
 *
 * Audited per spawn (bytes/ms/sections/present) because the design it replaces
 * failed invisibly for weeks for exactly the want of that line.
 *
 * `kind` ('dev' | 'chat') picks the framing and labels the audit line — an Atlas
 * CHAT gets the same retrieval through this same function (chatEvidence below);
 * it must stay ONE path with one set of guards.
 */
export async function atlasEvidence({ task, repo, root, maxBytes, slug, kind = 'dev' }) {
  const t0 = Date.now()
  const atlasRoot = root || resolveVault('atlas')?.path
  if (!atlasRoot) return ''
  const id = slug || slugify(task) || null
  try {
    const { text, stats } = await buildCandidates({ task, repo, root: atlasRoot, ...(maxBytes ? { maxBytes } : {}) })
    const block = evidencePrompt(text, { kind })
    audit({ action: 'atlas-evidence', kind, id, repo, ...stats, block: block.length, ok: true })
    return block
  } catch (e) {
    audit({ action: 'atlas-evidence', kind, id, repo, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 200), ok: false })
    return ''
  }
}

/**
 * The same retrieval for an Atlas CHAT's opening turn (spawnKnowledge above) —
 * against the ~3 s per discovery turn a chat otherwise spends re-finding pages
 * the dashboard can hand it before it says a word.
 *
 * ⚠️ NO `repo`, deliberately. A dev spawn names a repo, which resolves to a
 * project page and unlocks the TYPED half (project page + its open Tasks/ + its
 * hazards). A chat names nothing — only the operator's opening line — and
 * inferring a project from it is worse than omitting it: a question naming two
 * projects resolves to whichever matches an `agent_repo` key first, and a 4.6 KB
 * project section plus 20 of the WRONG project's open tasks would then sit at the
 * top of the block under a confident `Project:` header. So the chat gets the
 * full-text half only; when the question does name a project, that project's page
 * turns up as a ranked hit on its own merits, unlabelled and un-anchored.
 *
 * ⚠️ ATLAS ONLY. `buildCandidates` is written to the Atlas's shape — `Wiki/` +
 * `Tasks/`, `for_project` edges, section headers that name that vault's own
 * `index.md`/`log.md`. Another vault would not crash, it would produce
 * MISLABELLED evidence — so it gets none, and its chats stay byte-identical.
 */
export async function chatEvidence({ vaultKey, question, id, root }) {
  if (vaultKey !== 'atlas') return ''
  return atlasEvidence({ task: question, kind: 'chat', slug: id, ...(root ? { root } : {}) })
}

// The paired worker's FIRST turn. It no longer briefs the dev agent (the
// dashboard hands it the evidence directly, above) — but the worker still earns
// its keep at close, ingesting the dev agent's session recap into the Atlas, so
// it is still spawned and kept alive. This turn only parks it: one cheap no-tool
// reply that also confirms it booted.
export const ATLAS_WORKER_STANDBY =
  '# Stand by\nYou are paired to a dev agent that has just started. Do NOT brief it — the dashboard hands it the retrieved Atlas evidence directly, so there is nothing to research now.\n\nReply with the single line `standing by` — no tools, no reads, no writes. Your work comes later: the dashboard will hand you that dev agent\'s session recap to INGEST per your standing instructions.'

// The paired Atlas worker's launch line. Exported so its contract is testable
// without driving tmux (api/test/atlas-worker-tools.test.mjs): which MCP config
// it loads — the knowledge-only worker.mcp.json, never control.mcp.json — and
// that it stays far under TMUX_MAX_COMMAND_BYTES whatever `head` weighs. The
// only side effect is writing this session's prompt file (under STATE_DIR).
export function atlasWorkerLaunch({ id, sid, head }) {
  return promptFileLaunch(
    // The worker writes the ATLAS, so it stays on the subscription backend
    // whatever backend the dev agent it is paired to runs on — no `provider`.
    launchCommand(ATLAS_WORKER_LAUNCH_CMD, { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, sid }),
    id,
    head,
  )
}

/* Atlas worker: a knowledge worker PAIRED to a dev agent (see
 * the paired-worker design). Like spawnKnowledge it's a vault-
 * rooted interactive session with a pinned --session-id, BUT it works in a git
 * WORKTREE of the Atlas on its own branch `atlas/<slug>`, so its writes stay
 * isolated until the Atlas ship queue merges them. Spawned AFTER the dev agent
 * it belongs to exists (so a request that dies mid-spawn cannot leave a worker
 * with nothing to pair to), then cross-linked via pairAtlasWorker.
 *
 * Not operator-chatted, and it no longer briefs anyone: the dashboard retrieves
 * the Atlas evidence itself and pastes it into the dev agent's opening prompt
 * (atlasEvidence), so the worker's first turn only parks it (ATLAS_WORKER_STANDBY)
 * and its real job is the close-time recap INGEST. The Atlas path comes from the
 * vault registry (`atlas`); a soft failure (atlas not configured / box-local off)
 * means the dev agent simply runs UNPAIRED. */
export async function spawnAtlasWorker({ task, preamble, firstTurn }) {
  if (!task || typeof task !== 'string') return { status: 400, ok: false, error: 'task required' }
  if (!localRepoKeys().length) return { status: 503, ok: false, error: 'box-local executor disabled' }
  const atlas = resolveVault('atlas')
  if (!atlas) return { status: 503, ok: false, error: 'atlas vault not configured' }
  const noClaude = claudeUnavailable()
  if (noClaude) return noClaude

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

  // The worker's first turn: STAND BY by default (there is nothing to brief —
  // the dashboard hands the dev agent its evidence directly); the ingest path
  // passes its own `firstTurn` (the INGEST prompt) instead. The preamble
  // (standing INGEST/write rules) is prepended either way.
  const body = firstTurn || ATLAS_WORKER_STANDBY
  const head = preamble ? `${preamble}\n\n---\n${body}` : body
  const launch = atlasWorkerLaunch({ id, sid: claudeSessionId, head })
  ensureRepoTrusted(atlas.path) // so the Atlas worktree launch skips Claude Code's trust dialog
  const ns = await run(['tmux', 'new-session', '-d', '-s', tmux, '-c', worktree, 'sh', '-lc', launch])
  if (!ns.ok) {
    dropPromptFile(id) // the session's shell never ran, so it never removed it
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
// session's transcript — used to capture a closing dev agent's recap. Same
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
  if (hasText && text.length > PROMPT_MAX_CHARS) return { err: { status: 400, ok: false, error: `text too long (max ${PROMPT_MAX_CHARS} chars)` } }
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
//
// `send-keys -l` is a KEYBOARD, not a pipe: the bytes are parsed by Claude
// Code's input as key input, so an ESC inside the text opens a terminal escape
// sequence and takes the operator's words with it — an unterminated OSC-8
// hyperlink from a pasted chat-view excerpt ate most of a 957-char prompt in the
// incident this fixes, and the residue was submitted as the operator's message.
// sanitizeForTyping strips the sequences (and only them) first; tui-input.mjs
// carries the measurement.
//
// Then LOOK before submitting. The Enter used to be unconditional, which is the
// whole reason that incident was silent rather than obvious: a mangled buffer
// became a real user turn the model answered. If what we typed is not readable
// back off the pane we clear the box and fail, so the caller sees an error and
// the queue keeps the prompt for the next tick. Never delivered beats silently
// replaced — and both are loud (audit + the card's error).
async function deliver(s, payload) {
  const safe = sanitizeForTyping(payload)
  const stripped = payload.length - safe.length
  // ⚠️ NEVER type into a non-empty box. Whatever is in there — our own residue
  // from a refusal, a half-delivered prompt from a crash — the typed text
  // concatenates onto it and the next Enter submits the pair. Clearing is
  // VERIFIED, not counted: `C-u` kills a display ROW, so the count depends on
  // the wrapped height of content we didn't put there (tui-input.mjs).
  const io = {
    readPane: () => captureTail(s, TAIL_LINES, true),
    pressClear: () => run(['tmux', 'send-keys', '-t', s.tmux, TUI_CLEAR_KEY]),
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
  const t = await run(['tmux', 'send-keys', '-t', s.tmux, '-l', safe])
  if (!t.ok) return { ok: false, error: t.stderr.slice(0, 500) || 'send-keys failed' }
  if (TUI_VERIFY && safe.length <= TUI_VERIFY_MAX_CHARS && !(await typedTextLanded(s, safe))) {
    const post = await clearInputBox(io)
    audit({ action: 'deliver-mangled', id: s.id, repo: s.repo, len: safe.length, stripped, presses: post.presses, emptied: post.ok, ok: false })
    return { ok: false, error: 'input did not land in the session (not submitted)' }
  }
  await run(['tmux', 'send-keys', '-t', s.tmux, 'Enter'])
  return { ok: true, stripped, cleared }
}

// Read the typed text back off the pane. The pane lags the keystrokes, so this
// looks more than once (see TUI_VERIFY_SETTLE_MS) — the happy path still
// returns on the first look, and only a genuinely mangled buffer pays the wait.
// The capture keeps its SGR (`-e`): the box's faint placeholder is what tells
// an empty box from one holding text.
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
// and match them back when reconstructing history (agent-history.mjs tagSteered),
// which colors those bubbles apart in the chat view. Capped + persisted so the
// tagging survives a restart, like the rest of the session record.
const STEER_KEYS_MAX = 60
// `source` ('atlas' by default, 'system' for a dashboard-derived observation
// like a reply receipt, 'agent' for peer mail) rides IN the entry (steerEntry)
// so the chat view can name WHO injected the turn, not just "not the operator".
// A bare entry still means 'atlas', which keeps already-persisted state working.
// Without this a receipt renders as a turn the operator typed.
function recordSteer(s, text, steeredBy, source) {
  if (!steeredBy || typeof text !== 'string' || !text.trim()) return
  const key = steerEntry(steerKey(text), source)
  if (!Array.isArray(s.steered)) s.steered = []
  if (s.steered.includes(key)) return
  s.steered.push(key)
  if (s.steered.length > STEER_KEYS_MAX) s.steered = s.steered.slice(-STEER_KEYS_MAX)
}

// Minimal public description of a box-local session — who it is, so the routes
// layer can resolve a session's repo (the ship route's per-project prompt)
// without exposing the registry. Null when unknown.
export function describeSession(id) {
  const s = registry.sessions[id]
  if (!s) return null
  return { id: s.id, kind: s.kind || 'dev', repo: s.repo, vault: s.vault, task: s.task, status: s.status }
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
  audit({ action: 'prompt', id, repo: p.s.repo, len: p.payload.length, images: p.paths.length, ...(d.stripped ? { stripped: d.stripped } : {}), ...(d.cleared ? { cleared: d.cleared } : {}), ...(steeredBy ? { steeredBy } : {}), ok: true })
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
  audit({ action: 'interrupt', id, repo: p.s.repo, len: p.payload.length, images: p.paths.length, ...(d.stripped ? { stripped: d.stripped } : {}), ...(d.cleared ? { cleared: d.cleared } : {}), ...(steeredBy ? { steeredBy } : {}), ok: true })
  return { status: 200, ok: true }
}

/* How flushQueued re-checks an OBSERVATIONAL note against the world just before
 * typing it. The rule needs the spawn lineage, the merge claims and the merged
 * remote roster — all of which live in agent-routes.mjs, which imports THIS
 * module — so it is registered rather than imported. Unregistered (a test, a
 * bare import) means "nothing is known", i.e. deliver exactly as before. */
let noteRevalidator = () => null
export function setNoteRevalidator(fn) {
  noteRevalidator = typeof fn === 'function' ? fn : () => null
}

// Park a prompt to be delivered when the session next goes idle (the flush loop
// below does the sending). Appends to the session's FIFO queue, so queueing again
// while one is already parked keeps both (delivered in order). Images are saved now.
//
// `observedAt`/`about`/`header`/`note` are what an OBSERVATIONAL note (a fleet
// note, a turn-end line) adds: WHEN the dashboard saw the thing, WHICH child it
// is about, and the two pieces of `text` — because a note that has aged, or one
// batched into a digest, is re-assembled at delivery time and the attribution
// header has to stay first (queue-delivery.mjs `deliveryText`).
export async function queuePrompt({ id, text, images, kind, summary, steeredBy, source, observedAt, about, header, note }) {
  const p = await prepare(id, text, images)
  if (p.err) return p.err
  if (!Array.isArray(p.s.queued)) p.s.queued = []
  if (p.s.queued.length >= MAX_QUEUED) return { status: 409, ok: false, error: `queue full (max ${MAX_QUEUED})` }
  // `at` is the ENQUEUE time. A parked prompt waits for a delivery point the
  // session may not reach for a while — so how long it waited is the one number
  // that turns "the fleet updates feel laggy" into something measurable (the card
  // shows it per chip; flushQueued audits it on delivery, with `via`).
  p.s.queued.push({
    text: p.text, paths: p.paths, at: nowIso(),
    ...(kind ? { kind } : {}), ...(summary ? { summary } : {}),
    ...(observedAt ? { observedAt } : {}), ...(about ? { about } : {}),
    ...(header ? { header } : {}), ...(note ? { note } : {}),
    // Kept so a delivery that had to REBUILD the text (an age line, a digest)
    // can re-take the steer fingerprint over what was actually typed.
    ...(steeredBy ? { steeredBy } : {}), ...(source ? { source } : {}),
  })
  // Record now (by text); the parked prompt is delivered later and the
  // fingerprint matches whenever that turn lands in the transcript.
  recordSteer(p.s, p.text, steeredBy, source)
  persist()
  audit({ action: 'queue', id, repo: p.s.repo, len: p.payload.length, images: p.paths.length, depth: p.s.queued.length, ...(kind ? { kind } : {}), ok: true })
  return { status: 200, ok: true }
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
  if (text.length > PROMPT_MAX_CHARS) return { status: 400, ok: false, error: `ship prompt too long (max ${PROMPT_MAX_CHARS} chars)` }
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
  audit({ action: 'queue-send-now', id, repo: s.repo, len: payload.length, images: (q.paths || []).length, ...(d.stripped ? { stripped: d.stripped } : {}), ...(d.cleared ? { cleared: d.cleared } : {}), ok: true })
  return { status: 200, ok: true }
}

/* Drop observations that stopped being true while they waited, LOUDLY — the
 * same principle as the ship notifier's giving-up path: a note that
 * deliberately never fires must still be visible somewhere. Console + the bus
 * log (`delivered: false`, with the reason), so `agent-messages.jsonl` remains
 * the one place a note's whole life is readable. */
function dropStaleNotes(s, drops) {
  for (const { entry, reason } of drops) {
    console.log(`[agent-local] stale ${entry.kind} for ${s.id} dropped — ${reason}`)
    appendMessage({ from: entry.steeredBy || 'system:fleet', to: s.id, kind: entry.kind, text: entry.note || entry.text, delivered: false, reason: `stale: ${reason}` })
  }
  s.queued = s.queued.filter((e) => !drops.some((d) => d.entry === e))
  if (!s.queued.length) delete s.queued
  persist()
  audit({ action: 'queue-stale', id: s.id, repo: s.repo, dropped: drops.length, reasons: drops.map((d) => d.reason), ok: true })
}

/* Teardown purge: a child that is gone can have nothing more said about it, and
 * the parent chat either asked for the teardown or was told about it. Only
 * OBSERVATIONAL notes go — a `reply-receipt` answers a message the parent
 * actually sent and is still worth having, however late.
 *
 * flushQueued's revalidation would drop these anyway (`child` absent), a tick
 * later and one at a time; doing it at the teardown makes the count one log
 * line instead of N, and takes them out of the digest they'd otherwise pad. */
export function purgeNotesAbout(childId) {
  let purged = 0
  for (const s of Object.values(registry.sessions)) {
    if (!Array.isArray(s.queued) || !s.queued.length) continue
    const keep = s.queued.filter((q) => !(isObservational(q.kind) && q.about && q.about.childId === childId))
    if (keep.length === s.queued.length) continue
    const n = s.queued.length - keep.length
    purged += n
    s.queued = keep
    if (!s.queued.length) delete s.queued
    console.log(`[agent-local] purged ${n} stale note(s) about ${childId} from ${s.id} on teardown`)
  }
  if (purged) {
    persist()
    audit({ action: 'queue-purge', id: childId, notes: purged, ok: true })
  }
  return purged
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
      // Backing off a head that keeps being refused (deliveryBackoffMs) — the
      // message stays queued, we just stop asking every 3 s.
      if (s.deliverRetryAt && Date.now() < s.deliverRetryAt) continue
      if (!(await sessionAlive(s))) continue
      const pane = await captureTail(s, TAIL_LINES)
      // ONE delivery per session per tick, and the queue's own order decides
      // which — except that an idle-only entry no longer BLOCKS the
      // boundary-eligible ones behind it, and that stale observations are
      // dropped before anything is typed (queue-delivery.mjs `selectDelivery`).
      // The ship-train and menu guards live inside the same decision.
      const sel = selectDelivery({
        queue: s.queued,
        revalidate: (e) => noteRevalidator(s.id, e),
        busy: isBusy(pane),
        menu: !!menuKindOf(pane),
        shipHead: s.id === shipHead,
        boundaryEnabled: BOUNDARY_DELIVERY,
        sinceBoundaryMs: s.boundaryAt ? Date.now() - s.boundaryAt : null,
      })
      if (sel.drops.length) dropStaleNotes(s, sel.drops)
      if (!sel.pick) continue
      const picked = new Set(sel.pick.entries)
      const q = sel.pick.entries[0]
      const dec = { via: sel.pick.via }
      const text = deliveryText(sel.pick.entries, Date.now())
      const payload = withImages(text, sel.pick.entries.flatMap((e) => e.paths || []))
      const d = await deliver(s, payload)
      if (!d.ok) {
        s.deliverFailures = (s.deliverFailures || 0) + 1
        const backoffMs = deliveryBackoffMs(s.deliverFailures)
        if (backoffMs) {
          s.deliverRetryAt = Date.now() + backoffMs
          console.error(`[agent-local] delivery to ${s.id} refused ${s.deliverFailures}x (${d.error}) — holding ${Math.round(backoffMs / 1000)}s; the message stays queued`)
          audit({ action: 'queue-backoff', id: s.id, repo: s.repo, failures: s.deliverFailures, backoffMs, error: d.error, ok: false })
        }
        persist()
        continue
      }
      delete s.deliverFailures
      delete s.deliverRetryAt
      s.lastPrompt = { text, at: nowIso() }
      // The steer fingerprint is taken over the DELIVERED string, so a text this
      // path had to rebuild (an age line, a digest, image paths) must be
      // re-recorded or the chat view loses the bubble's colour for it.
      if (text !== (q.text || '') || payload !== text) recordSteer(s, payload, q.steeredBy, q.source)
      // Stamp the mid-turn delivery so the next one is paced (BOUNDARY_MIN_GAP_MS)
      // rather than following on the next 3 s tick.
      if (dec.via === 'boundary') s.boundaryAt = Date.now()
      // By identity, never by index: the stale drop above already re-shaped the
      // queue, and a digest takes several entries that need not be adjacent.
      s.queued = s.queued.filter((e) => !picked.has(e))
      if (!s.queued.length) delete s.queued
      persist()
      // waitMs: enqueue → actual delivery. This is the real lag of a parked
      // prompt, and the only place it is recorded. `via` splits the two
      // populations (boundary vs idle); `kind` says which class jumped the
      // queue, and `notes` how many observations one digest collapsed.
      const waitMs = q.at ? Date.now() - Date.parse(q.at) : null
      audit({ action: 'queue-flush', id: s.id, repo: s.repo, len: payload.length, images: (q.paths || []).length, ...(d.stripped ? { stripped: d.stripped } : {}), ...(d.cleared ? { cleared: d.cleared } : {}), ...(waitMs != null && waitMs >= 0 ? { waitMs } : {}), via: dec.via, ...(q.kind ? { kind: q.kind } : {}), ...(sel.pick.digest ? { notes: sel.pick.entries.length } : {}), ok: true })
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
    purgeNotesAbout(s.id)
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
export const ATLAS_KNOWLEDGE_CLOSE_PROMPT =
  process.env.AGENT_ATLAS_KNOWLEDGE_CLOSE_PROMPT ||
  'This chat is being closed. Final turn — three things. FIRST, tidy up the dev agents you spawned. cleanup_agent is the ⌦ teardown — it force-deletes the branch — so run it ONLY on an agent whose work is already SHIPPED/merged (check shipState in list_agents): it recaps → logs the session to the Atlas → removes the worktree + branch, leaving no orphan. For any spawned agent whose work is NOT yet shipped, do NOT delete it — leave it running and ASK the operator to confirm cleanup (name it here and send_message them), since its branch would otherwise be lost. SECOND, if this conversation produced insights, corrections, or research findings NOT yet in the Atlas, work them in now the TYPED way — update the most fitting page (or add one focused page), and think QUERY-FIRST: add the typed edges + dates the operator would later filter/traverse for (consult Wiki/Legend.md first; reuse a registered snake_case key, or coin + register a new one in the SAME edit), overwrite live state in place, and append a Wiki/log.md entry (## [YYYY-MM-DD] ingest | <title>). Then pull-rebase, commit only your files, and push. THIRD, before filing any NEW Tasks/ note, check whether the work that shipped CLOSED an open one — search Tasks/ for open notes (status not done) matching it by for_project, PR number or subject, and prefer closing over filing. Close on EVIDENCE only, never on age or plausibility: the PR is merged AND the task is genuinely what that work did, so set status: done + done: <YYYY-MM-DD>, bump updated, and append one dated ## Log line naming the PR and merged SHA; if completion still needs a deploy that has not happened, or the match is a judgement call, LEAVE IT OPEN and say so here. If everything durable is already saved (or nothing came up), just reply "nothing to save". Keep it brief — the session ends when you finish.'
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
  'This session is closing. Final turn — no tools, no edits: reply with a TIGHT recap of THIS session for the Atlas knowledge base. What changed and why, the key decisions and any dead-ends, and anything that CONTRADICTS the Atlas evidence you were given at the start. A few sentences or a short list — durable knowledge only, not a play-by-play. The session ends when you finish.'

// The ingest prompt handed to the paired worker once the dev recap is captured.
export function atlasIngestPrompt(recap, dev) {
  return `The dev agent you briefed (\`${dev.id}\`, branch \`${dev.branch}\`, worktree \`${dev.worktree}\`) has finished. Its session recap:\n\n${recap}\n\nINGEST this per your INGEST instructions: update the most fitting page and ALWAYS append at least one Wiki/log.md entry; note any contradiction with what the Atlas previously claimed. CLOSE BEFORE YOU FILE: check whether this work RETIRES an open Tasks/ note (\`status\` not \`done\`, matched by \`for_project\` / PR number / subject) and close it per your TASKS instructions — on evidence only (merged, and genuinely what this work did); if it is a judgement call or still owes a deploy, leave it open and say so. If the recap names a concrete follow-up/next-step or the dev task was an explicit "add a task" request, also file a focused Tasks/<slug>.md tagged to its project (\`for_project: "[[<Project>]]"\`, matched against Wiki/Projects/) so it lands on the Kanban. You may read the dev branch's diff for detail. Commit to YOUR branch with a clear message — do NOT push and do NOT touch main; the dashboard merges your branch. End with ATLAS:INGESTED on its own line.`
}

// Ingest prompt for a REMOTE (workstation) dev agent. Same INGEST contract, but
// the dev agent ran in a container the box can't reach — so the worker works from
// the recap ALONE (it cannot read the remote diff).
export function atlasIngestPromptRemote(recap, dev) {
  return `A dev agent (\`${dev.id}\`${dev.task ? `, task: "${dev.task}"` : ''}) running on a remote workstation has finished. Its session recap:\n\n${recap}\n\nINGEST this per your INGEST instructions: update the most fitting page and ALWAYS append at least one Wiki/log.md entry; note any contradiction with what the Atlas previously claimed. CLOSE BEFORE YOU FILE: check whether this work RETIRES an open Tasks/ note (\`status\` not \`done\`, matched by \`for_project\` / PR number / subject) and close it per your TASKS instructions — on evidence only (merged, and genuinely what this work did); if it is a judgement call or still owes a deploy, leave it open and say so. If the recap names a concrete follow-up/next-step or the dev task was an explicit "add a task" request, also file a focused Tasks/<slug>.md tagged to its project (\`for_project: "[[<Project>]]"\`, matched against Wiki/Projects/) so it lands on the Kanban. The dev agent ran on a remote box, so work ONLY from this recap — you cannot read its diff. Commit to YOUR branch with a clear message — do NOT push and do NOT touch main; the dashboard merges your branch. End with ATLAS:INGESTED on its own line.`
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
    await sleep(ATLAS_TURN_POLL_MS)
    if (!(await sessionAlive(worker))) break
    if (isBusy(await captureTail(worker, TAIL_LINES))) { sawBusy = true; continue }
    if (sawBusy || Date.now() - started > ATLAS_TURN_GRACE_MS) break
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
  sampleMerged().catch(() => {}) // self-throttled to MERGED_CHECK_MS
}, QUEUE_FLUSH_MS)
if (flushTimer.unref) flushTimer.unref() // don't keep the process alive for this

// Crash self-heal: once the process is up, park any sessions a tmux-server death
// orphaned and re-attach the newest few (capped + staggered + memory-gated — see
// reconcileOrphans). Delayed so Express finishes starting; detached and
// best-effort, so neither a hiccup nor the staggered launches block boot.
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

// Verified selection of a pending choice-menu option — never a blind
// arrow+Enter replay. Navigate the ❯ highlight toward the option whose TEXT is
// `optionText`, never trusting `hintN` (the client's best guess at its row,
// from the pane-parsed menuOptions) for anything but picking an initial
// direction, confirming by content at every step (driveSelect, menu.mjs), and
// press Enter ONLY once it's confirmed there. If it can't be confirmed within a
// bounded number of steps, Enter is never sent and this returns an error the
// card surfaces. A blind replay computed from a wrong/stale highlight is
// exactly how a menu answer once landed on option 1 while the operator meant
// option 5 — an unconfirmed pick is worse than none.
//
// There is deliberately no transcript correlation here: Claude Code writes a
// pending AskUserQuestion's tool_use to disk only when it flushes it together
// with the tool_result, i.e. after the answer — so a live pending menu has no
// id to correlate against (see menu.mjs's module doc-comment). The pane is the
// source, before and after.
export async function selectChoice({ id, optionText, hintN }) {
  const s = registry.sessions[id]
  if (!s) return { status: 404, ok: false, error: 'no such session' }
  if (typeof optionText !== 'string' || !optionText.trim()) return { status: 400, ok: false, error: 'optionText required' }
  if (!(await sessionAlive(s))) return { status: 409, ok: false, error: 'session not running' }
  const readHighlight = async () => {
    const pane = await captureTail(s, TAIL_LINES)
    return menuKindOf(pane) === 'choice' ? currentHighlight(pane) : null
  }
  const sendKey = async (key) => {
    const r = await run(['tmux', 'send-keys', '-t', s.tmux, key])
    if (r.ok) await sleep(SELECT_STEP_MS)
    return r.ok
  }
  const result = await driveSelect({ target: optionText, hintN, sendKey, readHighlight })
  if (!result.ok) return { status: 409, ok: false, error: result.error }
  // A menu confirmation can unblock a run — attribute it (no free-text prompt).
  s.lastPrompt = { text: '(menu choice)', at: nowIso() }
  persist()
  audit({ action: 'select', id, repo: s.repo, text: optionText, ok: true })
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
  purgeNotesAbout(id)
  delete registry.sessions[id]
  persist()
  audit({ action: 'kill', id, repo: s.repo, branch: s.branch, worktree: s.worktree, ok: true })
  return { status: 200, ok: true }
}

// Remove a dev agent's on-disk artifacts: its git worktree + branch, plus any
// uploads/stats/downloads files. (Knowledge agents have no worktree — theirs IS
// the vault root.) Shared by cleanup() and the ⌦-initiated graceful close.
async function removeAgentArtifacts(s) {
  if (s.kind !== 'knowledge') {
    await run(['git', '-C', s.path, 'worktree', 'remove', s.worktree, '--force'])
    await run(['git', '-C', s.path, 'branch', '-D', s.branch])
  }
  try {
    fs.rmSync(path.join(STATE_DIR, 'uploads', s.id), { recursive: true, force: true })
    fs.rmSync(statsFile(s.id), { force: true })
    fs.rmSync(downloadsDir(s.id), { recursive: true, force: true })
  } catch {
    /* best-effort: leftover upload/stats/downloads files are harmless */
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
  purgeNotesAbout(id)
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
