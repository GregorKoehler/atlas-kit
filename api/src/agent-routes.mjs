/* ------------------------------------------------------------------ *
 * Dev-agent control — dashboard-side router across two bridges
 *.
 *
 * Agents run in one of two places, keyed by repo:
 *   - WORKSTATION repos → forwarded to agent-bridge/ over the Tailscale
 *     tailnet (BRIDGE bearer injected server-side; degrades to
 *     "unreachable" when the workstation is offline).
 *   - BOX-LOCAL repos (allowlisted in agent-local-repos.json) → the
 *     in-process executor (agent-local.mjs), running git/tmux on THIS box.
 *     Always reachable (no network hop). ⚠️ execution on the control plane.
 *
 * Two tokens, two hops for the remote path (defense in depth):
 *   browser → [Caddy injects DASHBOARD_BEARER_TOKEN] → this proxy
 *           → [proxy injects AGENT_BRIDGE_TOKEN]      → the bridge
 *
 * GET /api/agents is open (read-only; gated at the Cloudflare Access edge)
 * and MERGES sessions from both bridges. The exec routes (spawn/prompt/kill/
 * output) are routed by repo (spawn) or by which executor owns the id.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import * as local from './agent-local.mjs'
import { bridges, bridgeForRepo, defaultBridge, defaultLabel, bridgeByLabel, advertisedRepos } from './bridges.mjs'
import { generateTitle, withTitles } from './agent-titles.mjs'
import { trackPhase, recordLifetime } from './agent-timings.mjs'
import { parseChoiceMenu } from './menu.mjs'
import { resolveVault, isTypedVault } from './vaults.mjs'

// Remote bridges (workstation + any in bridges.json) are resolved per-repo /
// per-id through bridges.mjs; the legacy AGENT_BRIDGE_URL/TOKEN is the default
// catch-all bridge there. See bridges.example.json.
// Short timeout for the GET poll (keep the card snappy when the bridge is
// offline). Exec routes get a much longer leash: spawn shells `git worktree
// add` inside the container, which can take many seconds on a big repo.
const BRIDGE_TIMEOUT_MS = Number(process.env.AGENT_BRIDGE_TIMEOUT_MS || 4000)
const BRIDGE_EXEC_TIMEOUT_MS = Number(process.env.AGENT_BRIDGE_EXEC_TIMEOUT_MS || 30000)
// Cap on image attachments per prompt (also enforced in each executor).
const MAX_IMAGES = Number(process.env.AGENT_MAX_IMAGES || 6)
// The prompt route opts out of the global 32kb parser (LARGE_BODY_ROUTES in
// server.mjs) so it can carry base64 images; parse it here with a roomier limit.
const jsonPrompt = express.json({ limit: process.env.AGENT_PROMPT_BODY_LIMIT || '24mb' })

// Standing instructions injected into every spawned agent's prompt (appended by
// the executor AFTER the task — the slug/branch derive from the task, not this).
// Lives here in the dashboard, so the protocol text is editable with no bridge
// redeploy; the executors just append whatever `preamble` they're handed.
const RECONCILE_PREAMBLE =
  process.env.AGENT_RECONCILE_PREAMBLE ||
  `You are a worktree-isolated agent on your own \`agent/<id>\` branch; other agents may be working the same repo in parallel.

Sub-agents: you may spawn read-only sub-agents (the Agent tool) to parallelize work that fans out across many files or independent investigations — exploring the codebase, locating call sites, reading many files, running tests/builds, researching APIs, and drafting changes. They stay READ-ONLY on disk: a sub-agent never edits files itself. A sub-agent reports its findings, and when it works out a change it returns that as a concrete proposed diff (unified-diff / patch form, with file paths) in its result — it does not apply it. You are the SOLE WRITER: apply each proposed diff yourself, serially, in this worktree — review it, adapt it to the current file state (sub-agents work from snapshots that may have drifted), reject or revise as needed, and build/test between applications — so the work stays coherent on one branch and one PR. Do the writing yourself.

Background jobs: when you launch a long-running script with the Bash tool's run_in_background, the dashboard tracks it automatically from your transcript — no opt-in needed. The job appears on your card and in the agents overview as running until the harness's completion notification flips it to done or failed; jobs your sub-agents launch are attributed to them. Always give a background job a clear, specific \`description\` — that text is the label the operator sees.

Sync protocol — when asked to "sync", or before you open/update your PR:
1. \`git fetch origin\` then \`git rebase origin/master\`.
2. Resolve only mechanical/obvious conflicts, sanity-check, then \`git push --force-with-lease\`.
3. If a conflict is ambiguous, semantically risky, or large: STOP, do NOT push, and post a short summary so the operator can merge manually.
Never force-resolve conflicts you're unsure about; never touch another agent's branch.

Ship protocol — when asked to "ship", "merge", "deploy", or "go live":
1. ALWAYS re-run the sync protocol first, on a fresh \`git fetch origin\` — even if you synced moments ago, another agent's PR may have landed on master since.
2. Only if the rebase was clean: push, open or update your PR, and once it is mergeable merge it with \`gh pr merge --merge\`.
3. Reply with the PR number + merged SHA. The production deploy itself is the operator's dashboard action — never build from your worktree or restart services unless your task explicitly says to.

Ship-readiness signal — the dashboard watches your replies for marker lines, each alone on its own line; emit one only when its condition is actually true, never speculatively:
- The moment you judge your work complete and mergeable (committed, pushed, build/tests pass, no open questions), end that reply with the line: ATLAS:READY-TO-SHIP
- After the ship protocol's merge succeeds, end that reply with the line: ATLAS:SHIPPED PR #<number> <merged SHA>`

// The Atlas Dev Preamble — our canonical "how we build" block, appended to EVERY dev
// agent (box-local AND workstation, every repo) so the reuse-first / minimal-diff reflex
// isn't limited to repos that happen to ship a `.claude/rules` file. It's our merge of the
// Karpathy guidelines (understand first · simplicity · surgical changes · verify) with
// ponytail's decision ladder (reuse→stdlib→native→installed-dep); an A/B trial found this
// ~1-screen distillation matched the full ponytail plugin on code quality without its
// scope-creep. Env-overridable for pilots/tuning via AGENT_ATLAS_DEV_PREAMBLE.
const ATLAS_DEV_PREAMBLE =
  process.env.AGENT_ATLAS_DEV_PREAMBLE ||
  `How we build (applies to every change):
Understand before you change — read the task and the code it touches and trace the real flow end to end. State assumptions; if the request is ambiguous or a simpler approach exists, say so before building. A small change in the wrong place is a second bug, not a fix.
Climb a ladder and stop at the first rung that holds: (1) REUSE what already exists here — a helper, util, type, pattern, or CSS class — before writing new; look before you write. (2) The standard library. (3) A native platform feature (\`Intl\`, a CSS rule, a DB constraint) over a hand-rolled version or a new dependency. (4) An already-installed dependency — never add one for what a few lines cover. (5) One line if it can be; then the minimum that works. Two same-size options → take the edge-case-correct one (lazy means less code, not a flimsier algorithm).
Build exactly what's asked — no unrequested abstractions, config, flexibility, or "for later" boilerplate. Keep it surgical: touch only what the task needs, match the surrounding style, don't refactor working code, and remove only the imports/vars your own change orphaned (mention other dead code, don't delete it).
When FIXING A BUG, fix the root cause, not the symptom — grep every caller of the function you touch and fix the shared function once, where all callers route through.
Never simplify away: input validation at trust boundaries, error handling that prevents data loss, security, or accessibility basics. Leave non-trivial logic with a way to verify it (a test or a runnable check), following this repo's conventions.
When you deliberately defer something, say so in one line — skipped: <what>, add when <trigger>.`

// Appended to EVERY dev agent's preamble (box-local AND workstation). The
// `{statsFile}` token is the live-stats file the agent rewrites; like APP_PREAMBLE
// it's substituted per-location by each EXECUTOR at spawn — the box-local path
// (agent-local.mjs) to a file on the box, the bridge path to a file inside the
// container. The box accumulates each counter's history for the card's mini-plots:
// box-local agents from sampling that file directly (sampleLiveStats), workstation
// agents from the latest values the bridge reports each poll (accumulateRemoteStats).
const STATS_PREAMBLE =
  process.env.AGENT_STATS_PREAMBLE ||
  `Live stats — optional, for long-running work whose progress is worth watching (a crawl, a batch job, a big sweep): your dashboard card can show a small live display — counters with a mini-plot of their history, and completion bars — fed from one file:
{statsFile}
Rewrite that file (overwrite the whole thing) with a flat JSON object whenever there is fresh progress; the dashboard samples it every few seconds and keeps the history server-side, so each write only carries the LATEST numbers:
- "label": number → a counter tile; its sampled history is drawn as a small cumulative-style plot.
- "label": [done, total] → a completion bar.
Up to 6 entries; keys are the labels shown (keep them short). The natural writer is the long-running job itself — make the script you launch in the background rewrite the file each batch, e.g.: printf '{"pages": %d, "batch": [%d, %d]}' "$pages" "$i" "$total" > '{statsFile}'. Delete the file when the work is done to clear the display. Skip all of this for short or single-step tasks.`

// Appended to EVERY dev agent's preamble (box-local AND workstation). A standing
// capability note: the agent may run a web app (Streamlit etc.) on its slot, which
// the dashboard embeds beside the transcript in full-screen. The slot's bind
// address/port/base-path are substituted per session by each EXECUTOR at spawn —
// not here: loopback:8701 on the box (one shared slot per box), or a per-session
// port in the container's band reached by container IP on the workstation (so
// parallel agents' apps don't collide). Pure steering text: an agent whose task
// has no UI simply ignores it.
const APP_PREAMBLE =
  process.env.AGENT_APP_PREAMBLE ||
  `Live app preview — you can run one or more web apps (e.g. Streamlit) that the operator views BESIDE your transcript in the dashboard's full-screen split view. To make an app show up:
- Bind it to your assigned address {appAddress} on port {appPort}, served under the base URL path "{appBasePath}" (the dashboard proxies that exact path to it). That address, port and base path are assigned to YOUR session, so what you serve there shows up beside your transcript.
- Streamlit, concretely: streamlit run app.py --server.address {appAddress} --server.port {appPort} --server.baseUrlPath {appBasePath} --server.headless true --server.enableCORS false --server.enableXsrfProtection false
- Launch it as a BACKGROUND job (Bash run_in_background) with a clear \`description\` so it keeps running while you work; the pane appears the moment it's serving and the operator can refresh/iterate.
- Skip all of this unless the task is about building or seeing a web UI.`

// Standing instructions for KNOWLEDGE agents — interactive chats over the work
// vault, spawned from the Knowledge Base tab. Box-local only (the box owns the
// vault). Replaces the dev preambles: no branch/PR protocol applies; the
// contract is grounding, gap-driven research, and add-and-link vault writes.
const KNOWLEDGE_PREAMBLE =
  process.env.AGENT_KNOWLEDGE_PREAMBLE ||
  `You are a KNOWLEDGE AGENT: an interactive chat over the operator's personal knowledge base. Your working directory is the vault root (an Obsidian vault). The wiki lives in \`Wiki/\`, captured notes in \`Inbox/\`; the vault's own CLAUDE.md documents the page schema and conventions — read it before your first write.

Grounding contract — every answer starts from the vault:
1. Search the vault FIRST (Grep/Glob/Read over Wiki/ and Inbox/) before answering.
2. For RELATIONAL or TIME-BASED questions ("what do I owe X", "what's due this week", "tasks in area Health", "who/what depends on X", "contacts past their cadence"), don't rely on prose full-text alone — the typed frontmatter answers these EXACTLY. If this vault has a \`Wiki/Legend.md\`, its typed edge/property keys are snake_case (e.g. \`owes\`, \`owed_by\`, \`for_project\`, \`area\`, \`depends_on\`, \`stakeholders\`, \`due\`, \`last_contact\`/\`cadence_days\`); grep those EXACT keys and filter/traverse the typed values for complete answers (direction is in the key name — \`owes\` = I owe, \`owed_by\` = owed to me).
3. Cite what you used: name the pages your answer draws on as [[wikilinks]].
4. Be explicit about coverage: clearly separate "what the knowledge base says" from your own general knowledge, and say plainly when the vault has nothing on a sub-question — never present outside knowledge as vault content.

Research on gaps: when a question exposes a gap in the knowledge base worth filling, name the gap and offer to research it — or research right away when the operator asked for that. Use WebSearch/WebFetch. Fold the results into the vault, then answer in chat with the new citations.

Parallel work — use it whenever the job splits:
- Sub-agents (the Agent tool): fan out read-only sub-agents for independent legs — parallel research runs on separate sub-topics, parallel sweeps over different corners of the vault, several search angles on one question. They return findings as TEXT and never touch files; you stay the sole writer.
- Background jobs (Bash run_in_background): launch long-running commands — e.g. separate search or crawl queries — in the background and keep chatting; the dashboard tracks each job from your transcript automatically and shows it on your card until it completes (jobs your sub-agents launch are attributed to them). Always give a background job a clear, specific \`description\` — that text is the label the operator sees.

Vault writes — you are the sole writer in this chat:
- Follow the vault CLAUDE.md conventions. Add-and-link only: create new pages or extend existing ones; NEVER rename, move, or delete existing pages; valid YAML frontmatter on every page you touch.
- Never write outside the vault; never touch \`data/\` (machine-owned) or \`.obsidian/\`.
- Other writers exist (phone sync, capture/research ingest agents) — keep edits additive and ask before any sweeping reorganization.
- Commit after each batch of writes: \`git pull --rebase --autostash\`, then commit ONLY the files you added or edited with a clear message, then push. If the rebase conflicts, STOP and report it in chat instead of resolving destructively.

Chat style: keep replies short and conversational — durable knowledge belongs in vault pages, not in the transcript.`

// Standing instructions for the ATLAS AGENT — the interactive chat
// counterpart of the Knowledge Base's knowledge agent, but pointed at the typed,
// queryable Atlas (vault:'atlas'). Same shape as KNOWLEDGE_PREAMBLE (operator
// chat, cwd = the vault ROOT, no worktree, answers in chat then writes on close),
// but it BOTH searches and writes the typed way: full-text grep AND typed-edge /
// graph traversal for relational queries, and a query-first, Legend-governed write
// discipline (the "structured way using edge types" the operator asked for). It
// pushes to the live Atlas (pull-rebase) — unlike the paired ATLAS_WORKER which
// stays on a branch for the ship queue. Box-local only.
const ATLAS_KNOWLEDGE_PREAMBLE =
  process.env.AGENT_ATLAS_KNOWLEDGE_PREAMBLE ||
  `You are the ATLAS AGENT: an interactive chat over the operator's Knowledge Atlas — a typed, queryable LLM-wiki. Your working directory is the Atlas vault root. Read its \`CLAUDE.md\` ("the Guide") and \`Wiki/Legend.md\` ("the Legend" — the node/edge/property registry) before your first write: they are the schema and the write discipline. Synthesis pages live in \`Wiki/\` (start at \`Wiki/index.md\`); to-dos in \`Tasks/\` (\`type: task\`, status lifecycle inbox→next→doing→waiting→done); \`Wiki/log.md\` is the append-only timeline.

Grounding contract — every answer starts from the Atlas, using BOTH of its search regimes:
1. Full-text (prose) search — Grep/Glob/Read over \`Wiki/\` and \`Tasks/\` for keywords and concepts.
2. Typed / graph search — the Atlas payoff. For RELATIONAL or TIME-BASED questions ("what do I owe X", "what's due this week", "tasks in area Health", "who/what depends on X", "stakeholders of a project", "contacts past their cadence"), the typed frontmatter answers EXACTLY where prose misses. The Legend's edge/property keys are snake_case (\`owes\`, \`owed_by\`, \`for_project\`, \`area\`, \`depends_on\`, \`stakeholders\`, \`status\`, \`due\`, \`last_contact\`/\`cadence_days\`); grep those EXACT keys and then TRAVERSE the graph by following the \`[[wikilinks]]\` in their values (direction is in the key name — \`owes\` = I owe, \`owed_by\` = owed to me). E.g. \`grep -rn 'for_project:.*Atlas' Tasks/ Wiki/\`, then read the linked pages.
   If the \`query_atlas\` / \`query_vault\` tools are available to you, PREFER them over hand-rolled grep — \`query_atlas\` is the Atlas's typed relational/temporal query engine (filters/traversals over edges, node types, status, dates) and \`query_vault\` is its full-text search; the grep recipes above are the fallback when those tools aren't present.
3. Cite what you used as \`[[wikilinks]]\`. Separate "what the Atlas says" from your own general knowledge, and say plainly when the Atlas has nothing on a sub-question.

Research on gaps: when a question exposes a gap worth filling, name it and offer to research — or research right away when the operator asks. Use WebSearch/WebFetch, fold the results into the Atlas (the typed way, below), then answer in chat with the new citations.

Parallel work — use it whenever the job splits: fan out read-only sub-agents (the Agent tool) for independent legs — they return findings as TEXT and never touch files, so you stay the sole writer — and launch long-running commands with Bash run_in_background (give each a clear \`description\` — that's the label the operator sees).

Atlas writes — you are the sole writer in this chat, and you write the TYPED way:
- Add-and-link ONLY: create new pages or extend existing ones; NEVER rename, move, or delete; valid YAML frontmatter on every page you touch.
- Think QUERY-FIRST: wherever you link pages, also add the TYPED EDGE that names the relationship — the frontmatter key IS the edge type (\`for_project\`, \`depends_on\`, \`stakeholders\`, …) — plus the state/date fields the operator would later filter or traverse for (\`status\`, \`due\`, milestone dates, \`last_contact\`/\`cadence_days\`). A bare \`[[link]]\` where a typed edge fits is a missed query.
- Consult \`Wiki/Legend.md\` FIRST: reuse the registered key that fits; coin a new snake_case key only when none does and the edge is worth querying — and append it to the matching Legend table in the SAME edit, following its format, so the registry stays the source of truth.
- Overwrite live state in place; keep history in an append-only \`## Log\` section in the page body, never in frontmatter lists (per the Guide). Append a \`Wiki/log.md\` entry for each batch — newest at the bottom, format \`## [YYYY-MM-DD] <op> | <title>\`.
- Never write outside \`Wiki/\`/\`Tasks/\`; never touch \`data/\` (machine-owned) or \`.obsidian/\`. Other writers exist (phone sync, capture/research ingest) — keep edits additive; ask before any sweeping reorganization.
- Commit after each batch: \`git pull --rebase --autostash\`, then commit ONLY the files you added or edited with a clear message, then push. If the rebase conflicts, STOP and report it in chat instead of resolving destructively.

Chat style: keep replies short and conversational — durable knowledge belongs in Atlas pages, not in the transcript.`

// Appended to the ATLAS AGENT's preamble (vault:'atlas' only): it is ALSO an
// agent orchestrator. Its control.mcp.json launch (agent-local.mjs) enables the
// agent-control MCP tools (list_agents / agent_transcript / spawn_agent /
// prompt_agent / queue_agent / interrupt_agent / kill_agent) — thin wrappers over
// the dashboard's own /api/agents/* routes (same repo allowlist + audit log).
// Pure steering text: if the tools aren't present (flag off), the agent ignores it.
const ATLAS_CONTROL_PREAMBLE =
  process.env.AGENT_ATLAS_CONTROL_PREAMBLE ||
  `Agent orchestration — beyond answering from the Atlas, you can SPAWN, MONITOR, and STEER the operator's other agents. If the agent-control MCP tools (\`list_agents\`, \`agent_transcript\`, \`spawn_agent\`, \`prompt_agent\`, \`queue_agent\`, \`interrupt_agent\`, \`kill_agent\`, \`cleanup_agent\`) are available to you, this is part of your job — treat the chat as mission control.

- MONITOR first: \`list_agents\` is the live roster (every dev + knowledge agent, box-local and remote, with status/phase/context/ship state); \`agent_transcript\` reads one agent's recent terminal output. Read an agent's ACTUAL state before you judge or steer it. When the operator asks "how's X going?", check the transcript and say what it's really doing — working, idle/waiting on input, stuck, or done — then propose the next move.
- SPAWN: \`spawn_agent\` starts a DEV agent on a repo (\`repo\` = a spawnable key from \`list_agents\` — either \`localRepos\` (box-local) or any \`bridges[].repos\` entry (remote, e.g. \`my-app\`); hand it a sharp, self-contained task) or a KNOWLEDGE agent on a vault. It returns immediately and the agent runs on its own. Only spawn on a repo \`list_agents\` advertises (a \`localRepos\` key or a bridge's \`repos\`); NEVER spawn another Atlas orchestrator (a knowledge agent on vault \`atlas\`) — no recursion.
- STEER: to add context or instructions to a RUNNING agent, prefer \`queue_agent\` — it lands at the agent's next idle and never disrupts a turn. Use \`prompt_agent\` for an agent that's already idle, and \`interrupt_agent\` ONLY to stop one that's going wrong. \`kill_agent\` closes a session (dev worktrees are kept for review); \`cleanup_agent\` is the full teardown — recap → Atlas log, THEN it removes the worktree + deletes the branch (the dashboard's ⌦). Because it force-deletes the branch, run \`cleanup_agent\` ONLY once an agent's work is already SHIPPED/merged (check \`shipState\` in \`list_agents\`) — if the work has NOT shipped, DON'T tear it down; ask the operator to confirm first, or \`kill_agent\` it (that keeps the worktree + branch).
- ACT OUT LOUD: you act autonomously, but the operator is reading this chat — before you spawn, interrupt, or kill, say in ONE line what you're about to do and why, then do it. Don't kill or interrupt an agent that's mid-run unless the operator asked or it's clearly broken. For anything destructive you're unsure about, propose it and wait for a yes.

This orchestration is ADDITIVE to your knowledge work — grounding answers in the Atlas and writing insights back the typed way still applies.`

// Standing instructions for an ATLAS WORKER — the knowledge worker PAIRED to a
// dev agent (see the paired-worker design). Unlike a KNOWLEDGE
// agent it is not operator-chatted: the dashboard drives it (brief the dev agent
// at spawn, ingest the dev agent's recap at cleanup), and it works in a git
// WORKTREE of the Atlas on its own branch — so its writes never touch the live
// Atlas until the Atlas ship queue merges that branch. Box-local only.
const ATLAS_WORKER_PREAMBLE =
  process.env.AGENT_ATLAS_WORKER_PREAMBLE ||
  `You are an ATLAS WORKER paired to a dev agent. Your working directory is a git worktree of the operator's Atlas — a typed, queryable LLM-wiki. Read its \`CLAUDE.md\` ("the Guide") and \`Wiki/Legend.md\` ("the Legend") before your first write: they are the schema and the write discipline.

You have two jobs, both driven by the dashboard (this is NOT an operator chat):

1) BRIEF (at the start). When asked to brief the dev agent on a task, traverse the Atlas READ-ONLY — Grep/Glob/Read over \`Wiki/\` (start at \`Wiki/index.md\`), follow \`[[wikilinks]]\` — and reply with a SHORT briefing of what's relevant: prior decisions, related projects/people/concepts, constraints, and any open \`Tasks/\`. For relational/temporal lookups (\`for_project\`, \`area\`, \`depends_on\`, \`owes\`, \`due\`, \`last_contact\`), grep the EXACT snake_case typed keys (see the Legend) and filter/traverse their values — the typed layer gives exact answers where prose search misses (e.g. \`grep -rn 'for_project:.*ThisProject' Tasks/ Wiki/\`). Cite pages as \`[[wikilinks]]\`. Lead with what's LOAD-BEARING for this task, and end with explicit CAUTIONS the dev agent should act on — e.g. "⚠️ Respect: [[prior decision]] — don't change it without reason", "⚠️ Verify: the Atlas claims X; confirm it still holds". Skip generic background. If the Atlas has nothing relevant, say so plainly in one line. Write NOTHING at brief time.

2) INGEST (at the end). When handed the dev agent's session recap, fold it into the Atlas: update the most fitting existing page (or add one focused page) — and think QUERY-FIRST: add the typed edges and dates the operator would later *filter or traverse for* (\`for_project\`, \`depends_on\`, \`stakeholders\`, \`status\`, \`due\`, etc.), first consulting \`Wiki/Legend.md\` for the current node/edge/property types — reuse the key that fits, or coin + register a new snake_case key in the same edit when none does and the edge is worth querying; a bare \`[[link]]\` where a typed edge fits is a missed query. ALWAYS append at least one \`Wiki/log.md\` entry — newest at the bottom, format \`## [YYYY-MM-DD] <op> | <title>\` with \`op\` = \`ingest\`. Note any CONTRADICTION between the dev work and what a page previously claimed.
   TASKS (Kanban): if the recap names a concrete follow-up / next-step, or the dev agent's task was an explicit "add a task / Kanban item" request, file it as a focused \`Tasks/<slug>.md\` so it lands on the operator's Kanban — \`type: task\`, \`status: inbox\`, \`created\`/\`updated\` = today (YYYY-MM-DD). **Tag it to its project the typed way — \`for_project: "[[<Project>]]"\` — or it will NOT show under that project on the board.** Resolve \`<Project>\` by matching the named project against the ACTUAL \`Wiki/Projects/\` pages by title / filename / tag (partial or informal match is fine, e.g. "the payments project" → \`[[Payments-Service]]\`); if no project genuinely fits, use \`area: "[[<Area>]]"\` or \`for_project_idea: "[[<Idea>]]"\` per the Legend, or omit rather than guess. Add \`due\`/\`priority\`/\`tags\` only when the recap states them. Keep tasks FOCUSED — roadmap-level or a single named next-step with engineering consolidated, never one task per checkbox.
   Skip the page update (and the task) only if the session was a genuine no-op — but still log it.

Write discipline (per the Guide): add-and-link ONLY — create or extend pages and \`Tasks/\` entries, NEVER rename/move/delete; valid YAML frontmatter on every file you touch; never write outside \`Wiki/\` and \`Tasks/\` (and never \`data/\`). Commit your edits to your worktree's branch with a clear message; do NOT push and do NOT touch \`main\` — the dashboard's Atlas ship queue rebases your branch onto the latest Atlas and merges it. When you have committed an ingest, end that turn with the line \`ATLAS:INGESTED\` alone on its own line.

Keep replies short — durable knowledge belongs in Atlas pages, not in the transcript.`

// Spawn-time model/effort selection. The client sends a short key; the proxy
// resolves it to the full Claude Code model ID and validates effort against the
// CLI's accepted levels (the dashboard exposes high / "very high" (xhigh) / max).
// Defaults: Opus on xhigh.
//
// The 1M extended-context variant (`[1m]` suffix) is the DEFAULT — the
// subscription serves the 1M window without usage credits for Opus/Fable, so
// every spawn of those gets it. Set AGENT_EXTENDED_CONTEXT=0 (or false/no/off)
// to fall back to the standard context window as a global kill-switch. The
// meter's window default in agent-local.mjs tracks the same flag.
//
// EXCEPTION — Sonnet stays on the standard window: its 1M variant DOES require
// usage credits, which the subscription-auth path (blank ANTHROPIC_API_KEY)
// doesn't have, so `claude-sonnet-4-6[1m]` errors out with "Usage credits
// required for 1M context". So Sonnet never gets the `[1m]` suffix.
const EXTENDED_CONTEXT = !/^(0|false|no|off)$/i.test(process.env.AGENT_EXTENDED_CONTEXT || '')
const CTX = EXTENDED_CONTEXT ? '[1m]' : ''
const AGENT_MODELS = {
  fable: `claude-fable-5${CTX}`,
  opus: `claude-opus-4-8${CTX}`,
  sonnet: 'claude-sonnet-4-6',
}
const AGENT_EFFORTS = new Set(['high', 'xhigh', 'max'])

// Call a bridge; returns { ok, status, body } and never throws — a down bridge /
// timeout comes back as ok:false so callers can degrade. `bridge` is a resolved
// { url, token }; omit it to use the default (catch-all) bridge, which keeps the
// legacy single-bridge call sites unchanged.
async function callBridge(method, path, body, timeoutMs = BRIDGE_TIMEOUT_MS, bridge = defaultBridge()) {
  if (!bridge || !bridge.url || !bridge.token) {
    return { ok: false, status: 503, body: { error: 'bridge not configured' } }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${bridge.url}${path}`, {
      method,
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, body: data }
  } catch {
    return { ok: false, status: 502, body: { error: 'bridge unreachable' } }
  } finally {
    clearTimeout(timer)
  }
}

// id → bridge LABEL index, rebuilt from every /sessions poll across bridges
// (each session carries `repo`, and we know which bridge answered) and seeded at
// spawn. The id-routes (prompt/kill/…) resolve an id to its bridge here; an
// unknown id falls back to the default bridge — the legacy single-bridge target.
const idBridge = new Map() // id -> bridge label
// childId -> the session id of the agent that SPAWNED it (the Atlas orchestrator,
// via spawn_agent's `parent`). Overlaid as `spawnedBy` on GET /api/agents so the
// hero overview + Atlas constellation can draw the spawn lineage. PERSISTED to
// disk (loadSpawnParents / setSpawnParent below) so the edges survive an API
// restart/deploy — otherwise every restart orphaned previously-spawned agents
// into independent roots until they were re-spawned. Operator spawns carry no
// parent and read as roots.
const spawnParent = new Map() // childId -> parentId
function bridgeForId(id) {
  const label = idBridge.get(id)
  return (label && bridgeByLabel(label)) || defaultBridge()
}
// Forward an id-route to whichever bridge owns the id.
function callBridgeForId(method, path, body, id, timeoutMs) {
  return callBridge(method, path, body, timeoutMs, bridgeForId(id))
}

/* --- remote (workstation) agent time tracking ---------------------- *
 * The box-local executor instruments its own agents directly (agent-timings.mjs:
 * phase state-machine → `run` records → monthRunMsByRepo). The box can't scan
 * workstation agents' transcripts off its own disk, but the BRIDGE now scans them
 * inside the container and returns sub-agents / background jobs / context fill /
 * live stats on each session (readContainerTranscript) — so those render for
 * workstation agents too. Run/wait PHASES, though, aren't on the session: they're
 * derived here from the `status` stream the bridge returns each poll. We fold it
 * through the SAME state machine, against a persisted SHADOW session per remote
 * id, so workstation repos accrue `run` records too: their project cards get
 * "agent time · this month" and a live run timer, with no bridge change.
 * ------------------------------------------------------------------ */
const STATE_DIR = process.env.AGENT_LOCAL_DIR || path.join(os.homedir(), '.atlas-kit')
const REMOTE_TIMINGS_FILE = path.join(STATE_DIR, 'remote-timings.json')
// Independent poll cadence — mirrors the box-local flush timer (3s) so a remote
// run that starts AND ends while the dashboard is closed is still observed (the
// 5s GET poll alone would miss it). agent-timings debounces the busy-marker blip.
const REMOTE_PHASE_POLL_MS = Number(process.env.AGENT_REMOTE_PHASE_POLL_MS || 3000)
// Live phase fields mirrored from a shadow onto its session so the card renders
// the remote run timer exactly as for box-local agents (AgentList reads these by
// name; all-absent → it shows nothing, the prior behaviour).
const PHASE_FIELDS = ['phase', 'runStartedAt', 'runEstimateMs', 'runEstimateLoMs', 'runEstimateHiMs', 'lastRunMs', 'endedAt']

function loadRemoteShadows() {
  try {
    return JSON.parse(fs.readFileSync(REMOTE_TIMINGS_FILE, 'utf-8'))
  } catch {
    return {}
  }
}
const remoteShadows = loadRemoteShadows()

function persistRemoteShadows() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(REMOTE_TIMINGS_FILE, JSON.stringify(remoteShadows))
  } catch (e) {
    console.error('[agent-routes] remote-timings persist failed:', e.message)
  }
}

// Spawn lineage persisted across restarts (see spawnParent above). Same on-disk
// pattern as the shadows: rehydrate the in-memory map on boot, rewrite it on each
// new edge. Stale entries (children long gone) are harmless — the overlay only
// stamps `spawnedBy` on sessions that still exist — and stay negligibly small.
const SPAWN_PARENT_FILE = path.join(STATE_DIR, 'spawn-parents.json')
function loadSpawnParents() {
  try {
    const obj = JSON.parse(fs.readFileSync(SPAWN_PARENT_FILE, 'utf-8'))
    for (const [child, parent] of Object.entries(obj)) spawnParent.set(child, parent)
  } catch {
    /* no file yet — start empty */
  }
}
loadSpawnParents()
function persistSpawnParents() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(SPAWN_PARENT_FILE, JSON.stringify(Object.fromEntries(spawnParent)))
  } catch (e) {
    console.error('[agent-routes] spawn-parents persist failed:', e.message)
  }
}
// Record + persist a child→parent edge in one step (used at every spawn site).
function setSpawnParent(childId, parentId) {
  spawnParent.set(childId, parentId)
  persistSpawnParents()
}

// Fold one bridge /sessions poll into the remote shadows' phase state, and mirror
// each shadow's live phase fields back onto its session (what the card renders).
// Synchronous (trackPhase/recordLifetime are), so it's safe to call from both the
// GET handler and the independent timer. Call ONLY with sessions from a REACHABLE
// bridge: an empty list from a down bridge must not read as "every agent ended".
function trackRemotePhases(remoteSessions, label) {
  const now = Date.now()
  let changed = false
  const present = new Set()
  for (const rs of remoteSessions) {
    if (!rs || !rs.id) continue
    present.add(rs.id)
    idBridge.set(rs.id, label)
    let sh = remoteShadows[rs.id]
    if (!sh) {
      sh = remoteShadows[rs.id] = { id: rs.id, bridge: label, repo: rs.repo, kind: rs.kind || 'dev', task: rs.task || '', startedAt: rs.startedAt }
      changed = true
    }
    // model/effort are set at spawn; keep them fresh so the estimator buckets the
    // shadow like the real session (size isn't computed for workstation agents).
    for (const k of ['model', 'effort']) {
      if (rs[k] && sh[k] !== rs[k]) { sh[k] = rs[k]; changed = true }
    }
    if (rs.status === 'done') {
      if (recordLifetime(sh, now)) changed = true
    } else if (trackPhase(sh, rs.status, now)) {
      changed = true
    }
    for (const f of PHASE_FIELDS) if (sh[f] != null) rs[f] = sh[f]
    // Live stats: the bridge cats the container's stats file and returns the raw
    // latest {label:value}; accumulate the history box-side (mirrors the box-local
    // sampleLiveStats) keyed by the remote id, so workstation counters get the
    // same `points` mini-plots. Swap the raw object for the accumulated array (the
    // shape AgentList renders), or drop it when there are none.
    const stats = local.accumulateRemoteStats(rs.id, rs.stats)
    if (stats && stats.length) rs.stats = stats
    else delete rs.stats
  }
  // A shadow gone from a reachable bridge's list was cleaned up → close it, then
  // drop it (the durable record is already in the timings log). Never drop one
  // still present, or the next poll re-anchors a fresh phase and double-counts.
  for (const id of Object.keys(remoteShadows)) {
    if (present.has(id)) continue
    // Only reap shadows owned by THIS bridge's poll — another bridge's poll (or
    // this one while a sibling is down) must not close the others' agents.
    if ((remoteShadows[id].bridge || defaultLabel()) !== label) continue
    if (recordLifetime(remoteShadows[id], now)) changed = true
    delete remoteShadows[id]
    idBridge.delete(id)
    local.dropRemoteStats(id) // forget its accumulated mini-plot history too
    changed = true
  }
  if (changed) persistRemoteShadows()
}

// Remote dev agents the operator pressed Ship on. There's no serial ship train
// for remote (the ship is just a prompt queued to the bridge), so the box marks
// the id here and overlays the same shipQueue{active} the card renders as a
// "shipping…" spinner, until the agent's ATLAS:SHIPPED marker lands (or it's
// gone). That completes the ready ⤴ / shipping… / shipped ✓ triple for remote.
const remoteShipping = new Set() // remote id currently shipping
// Latest remote sessions seen across all bridges — refreshed by both the GET
// poll and the independent remote-phase poll, so the Atlas ship-note diff below
// can see workstation children even when the dashboard is closed.
let lastRemoteSessions = []

// Independent poll so the phase timer advances and a finished remote agent gets
// its lifetime record even with the dashboard closed (mirrors agent-local's flush
// timer). Re-entrancy-guarded; not started when no bridge is wired.
let pollingRemote = false
async function pollRemotePhases() {
  if (pollingRemote) return
  pollingRemote = true
  try {
    const collected = []
    await Promise.all(
      bridges().map(async (b) => {
        const r = await callBridge('GET', '/sessions', undefined, BRIDGE_TIMEOUT_MS, b)
        if (r.ok && Array.isArray(r.body.sessions)) {
          trackRemotePhases(r.body.sessions, b.label)
          collected.push(...r.body.sessions)
        }
      }),
    )
    lastRemoteSessions = collected
  } finally {
    pollingRemote = false
  }
}
if (bridges().length) {
  const remoteTimer = setInterval(() => { pollRemotePhases().catch(() => {}) }, REMOTE_PHASE_POLL_MS)
  if (remoteTimer.unref) remoteTimer.unref() // don't keep the process alive for this
}

/* --- remote (workstation) Atlas-paired graceful close --------------- *
 * Workstation dev agents get an Atlas BRIEFING at spawn (folded into their launch
 * prompt; that briefing worker is reaped right after). They have no live paired
 * worker, so at close we run an EPHEMERAL ingest: ask the agent for a marker-
 * delimited recap over the bridge, capture it from the bridge pane, then
 * local.ingestToAtlas spins up a short-lived box-local worker to fold it into the
 * Atlas (the paired-worker design — "ephemeral at cleanup"). This
 * mirrors a box agent's two-step ✕: the first press starts recap→ingest, a second
 * forces. Box-local agents are unaffected (they take the local.kill/cleanup path).
 * ------------------------------------------------------------------ */
const REMOTE_CLOSE_TIMEOUT_MS = Number(process.env.AGENT_REMOTE_CLOSE_TIMEOUT_MS || 5 * 60 * 1000)
const REMOTE_RECAP_POLL_MS = Number(process.env.AGENT_REMOTE_RECAP_POLL_MS || 2500)
const REMOTE_RECAP_GRACE_MS = Number(process.env.AGENT_REMOTE_RECAP_GRACE_MS || 20000)
const REMOTE_RECAP_LINES = Number(process.env.AGENT_REMOTE_RECAP_LINES || 500)
const RECAP_START = '===ATLAS-RECAP-START==='
const RECAP_END = '===ATLAS-RECAP-END==='
const REMOTE_RECAP_PROMPT =
  process.env.AGENT_REMOTE_RECAP_PROMPT ||
  `This session is closing. Final turn — no tools, no edits: write a TIGHT recap of THIS session for the Atlas knowledge base. Print the line ${RECAP_START} on its own, then the recap (what changed and why, the key decisions and any dead-ends, and anything that CONTRADICTS the Atlas briefing you got at the start), then the line ${RECAP_END} on its own. Durable knowledge only — a few sentences or a short list, not a play-by-play. The session ends after this.`

// Remote dev agents mid graceful-close: id → { cleanup, phase }. GET /api/agents
// stamps the session with closing/closePhase from this so the card shows the same
// "wrapping up" → "saving to Atlas" UX as a box agent.
const remoteClosing = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Pull the recap out of a bridge pane dump: prefer the marker-delimited block,
// fall back to the tail when the agent didn't emit the markers. Strips ANSI (the
// bridge /output keeps SGR escapes) and the TUI's left/right gutter chars.
function extractRecap(pane) {
  const clean = String(pane || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  const i = clean.lastIndexOf(RECAP_START)
  const j = clean.lastIndexOf(RECAP_END)
  const raw = i !== -1 && j > i ? clean.slice(i + RECAP_START.length, j) : clean.split('\n').slice(-40).join('\n')
  return raw
    .split('\n')
    .map((l) => l.replace(/^[\s│┃╎┆┊╏⏺]+/, '').replace(/[\s│┃╎┆┊╏]+$/, ''))
    .filter((l) => l && !l.includes(RECAP_START) && !l.includes(RECAP_END))
    .join('\n')
    .trim()
    .slice(0, 6000)
}

// Wait for the remote recap turn to finish (busy→idle, bounded), then read the
// recap off the bridge pane. '' if forced/cancelled mid-wait.
async function captureRemoteRecap(id, bridge) {
  const started = Date.now()
  let sawBusy = false
  while (Date.now() - started < REMOTE_CLOSE_TIMEOUT_MS) {
    if (!remoteClosing.has(id)) return '' // a second press forced the close
    await sleep(REMOTE_RECAP_POLL_MS)
    const r = await callBridge('GET', '/sessions', undefined, BRIDGE_TIMEOUT_MS, bridge)
    const s = r.ok && Array.isArray(r.body.sessions) ? r.body.sessions.find((x) => x && x.id === id) : null
    if (!s || s.status === 'done') break // gone → grab whatever's on the pane
    if (s.status === 'running') { sawBusy = true; continue }
    if (sawBusy || Date.now() - started > REMOTE_RECAP_GRACE_MS) break // idle after running (or grace)
  }
  const o = await callBridge('GET', `/output?id=${encodeURIComponent(id)}&lines=${REMOTE_RECAP_LINES}`, undefined, BRIDGE_TIMEOUT_MS, bridge)
  return extractRecap(o.ok && o.body ? o.body.output : '')
}

// Background: capture the recap, ingest it into the Atlas via an ephemeral worker,
// then tear down the remote agent on its bridge.
async function runRemoteAtlasClose(id, bridge, cleanup) {
  try {
    const recap = await captureRemoteRecap(id, bridge)
    if (remoteClosing.has(id)) remoteClosing.set(id, { ...remoteClosing.get(id), phase: 'ingest' })
    if (recap && remoteClosing.has(id)) {
      const task = (remoteShadows[id] && remoteShadows[id].task) || ''
      await local.ingestToAtlas({ recap, devId: id, devTask: task, preamble: ATLAS_WORKER_PREAMBLE }).catch(() => {})
    }
  } finally {
    // Tear down the dev agent on its bridge (✕ keeps the worktree, ⌦ removes it),
    // unless a second press already forced it (the kill route cleared the marker).
    if (remoteClosing.has(id)) {
      await callBridge('POST', cleanup ? '/cleanup' : '/kill', { id }, BRIDGE_EXEC_TIMEOUT_MS, bridge)
      remoteClosing.delete(id)
    }
  }
}

// First ✕/⌦ on a remote Atlas-paired agent → start the graceful recap→ingest and
// return a {closing:true} body. null when not applicable (atlas off / agent
// unreachable) or on a SECOND press (clears the marker so the caller forwards a
// plain force kill/cleanup — mirroring a box agent's second ✕, no ingest).
async function startRemoteAtlasClose(id, cleanup) {
  if (!local.atlasAvailable()) return null
  if (remoteClosing.has(id)) {
    remoteClosing.delete(id)
    return null
  }
  const bridge = bridgeForId(id)
  // Interrupt any in-flight turn and deliver the recap prompt (Escape + send).
  const d = await callBridge('POST', '/interrupt', { id, text: REMOTE_RECAP_PROMPT }, BRIDGE_EXEC_TIMEOUT_MS, bridge)
  if (!d.ok) return null // can't reach the agent → fall through to a plain kill
  remoteClosing.set(id, { cleanup, phase: 'recap' })
  runRemoteAtlasClose(id, bridge, cleanup).catch(() => remoteClosing.delete(id))
  return { ok: true, closing: true }
}

/* --- spawn orchestration (shared by the route and the scheduler) ---- *
 * The full spawn flow — validation, Atlas-worker pairing, box-local vs bridge
 * routing, title generation — lives here as a plain function returning
 * { status, body } so BOTH POST /api/agents/spawn and the scheduler (a spawn job
 * firing at its due time) replay the exact same behaviour. The route is a thin
 * wrapper; the scheduler calls it directly.
 * ------------------------------------------------------------------ */
async function performSpawn(raw) {
  const { task, repo, model, effort, kind, vault, images, parent } = raw || {}
  if (!task || typeof task !== 'string') return { status: 400, body: { ok: false, error: 'missing "task"' } }
  // `parent` (optional): the spawning agent's session id — set by the Atlas
  // orchestrator's spawn_agent tool so GET /api/agents can draw the lineage.
  if (parent !== undefined && typeof parent !== 'string') return { status: 400, body: { ok: false, error: 'invalid "parent"' } }
  if (kind !== undefined && kind !== 'knowledge')
    return { status: 400, body: { ok: false, error: 'unknown "kind" (expected knowledge)' } }
  if (kind !== 'knowledge' && (!repo || typeof repo !== 'string'))
    return { status: 400, body: { ok: false, error: 'missing "repo"' } }
  if (vault !== undefined && typeof vault !== 'string')
    return { status: 400, body: { ok: false, error: 'invalid "vault"' } }
  if (model !== undefined && !AGENT_MODELS[model])
    return { status: 400, body: { ok: false, error: `unknown "model" (expected ${Object.keys(AGENT_MODELS).join('/')})` } }
  if (effort !== undefined && !AGENT_EFFORTS.has(effort))
    return { status: 400, body: { ok: false, error: `unknown "effort" (expected ${[...AGENT_EFFORTS].join('/')})` } }
  // Image attachments fold into the opening prompt (dev agents only — the
  // executor saves them to disk and references their paths). Same shape/cap as
  // a prompt's; knowledge chats ignore them. (Scheduled spawns carry no images.)
  const imgs = Array.isArray(images) ? images : []
  if (imgs.length > MAX_IMAGES)
    return { status: 400, body: { ok: false, error: `too many files (max ${MAX_IMAGES})` } }
  if (imgs.some((im) => !im || typeof im.dataUrl !== 'string'))
    return { status: 400, body: { ok: false, error: 'each attachment needs a "dataUrl"' } }
  const modelId = AGENT_MODELS[model || 'opus']
  const effortLevel = effort || 'xhigh'
  // Knowledge agents are always box-local (the box owns the vault); `task` is
  // the operator's opening question. An optional `vault` key points the chat at
  // a non-default vault. Any TYPED vault (one carrying a Wiki/Legend.md — atlas,
  // a sibling vault, …) gets the typed, Legend-governed preamble + structured close;
  // plain vaults fall through to the generic Knowledge Base preamble. The agent-
  // ORCHESTRATION layer (the control MCP tools) is atlas-only — only the main
  // Atlas chat also gets ATLAS_CONTROL_PREAMBLE.
  if (kind === 'knowledge') {
    const preamble =
      vault === 'atlas'
        ? `${ATLAS_KNOWLEDGE_PREAMBLE}\n\n${ATLAS_CONTROL_PREAMBLE}`
        : isTypedVault(vault)
          ? ATLAS_KNOWLEDGE_PREAMBLE
          : KNOWLEDGE_PREAMBLE
    const r = await local.spawnKnowledge({ question: task, preamble, model: modelId, effort: effortLevel, vault })
    if (r.ok && r.id) {
      if (parent) setSpawnParent(r.id, parent)
      generateTitle(r.id, task).then((m) => m?.size && local.setSize(r.id, m.size))
    }
    const { status, ...body } = r
    return { status, body }
  }
  // The project-card "Now" protocol is box-local only (the executor that
  // applies it owns the vault), so only those agents carry it.
  // On success, kick off the spawn-time short title (fire-and-forget — the
  // response never waits; the overview falls back to the task until it lands).
  if (local.isLocalRepo(repo)) {
    // BOX: pair with an Atlas worker but DON'T block the spawn — start the dev
    // agent now, and once the worker's briefing is ready QUEUE it (briefAndQueue
    // → flushQueued delivers at the first idle, never mid-turn; it shows as the
    // ⏱ chip). Best-effort: no Atlas / box-local off → the dev agent runs unpaired.
    const w = await local.spawnAtlasWorker({ task, preamble: ATLAS_WORKER_PREAMBLE })
    const atlasWorker = w.ok && w.id ? w.id : null
    const preamble = `${RECONCILE_PREAMBLE}\n\n${ATLAS_DEV_PREAMBLE}\n\n${STATS_PREAMBLE}\n\n${APP_PREAMBLE}`
    // A short heads-up so the agent expects the briefing instead of charging ahead.
    const heads = atlasWorker
      ? '## Atlas briefing incoming\nA paired Atlas knowledge worker is preparing a briefing on prior knowledge relevant to this task — it will arrive shortly as a queued message (the ⏱ chip on your card). Fold it in when it lands before going deep.'
      : ''
    const r = await local.spawn({ task, repo, preamble, context: heads, model: modelId, effort: effortLevel, images: imgs })
    if (r.ok && r.id) {
      if (parent) setSpawnParent(r.id, parent)
      if (atlasWorker) {
        local.pairAtlasWorker({ devId: r.id, workerId: atlasWorker })
        local.briefAndQueue({ workerId: atlasWorker, devId: r.id }).catch(() => {}) // background; queues at first idle
      }
      local.recordSpawn(repo)
      generateTitle(r.id, task).then((m) => m?.size && local.setSize(r.id, m.size))
    } else if (atlasWorker) {
      local.cleanup({ id: atlasWorker }).catch(() => {}) // dev spawn failed — don't orphan the worker
    }
    const { status, ...body } = r
    return { status, body }
  }
  // Workstation dev agents run in a container the box can't observe — there's no
  // box-side queue for a remote session, so the briefing stays BLOCKING here:
  // the worker brief is folded into the launch prompt, and the ephemeral worker
  // is reaped before forwarding. (Non-blocking workstation briefing would need
  // bridge-side queueing — a follow-up.)
  let atlasContext = '',
    atlasWorker = null
  {
    const w = await local.spawnAtlasWorker({ task, preamble: ATLAS_WORKER_PREAMBLE })
    if (w.ok && w.id) {
      atlasWorker = w.id
      const brief = await local.briefWorker({ id: w.id })
      if (brief.ok && brief.text)
        atlasContext = `## Relevant Atlas context\n_Prior knowledge from your Atlas knowledge base — treat any ⚠️ flags as constraints._\n\n${brief.text.trim()}`
    }
  }
  if (atlasWorker) local.cleanup({ id: atlasWorker }).catch(() => {})
  const bridge = bridgeForRepo(repo)
  const r = await callBridge(
    'POST',
    '/spawn',
    {
      task,
      repo,
      // STATS_PREAMBLE carries the `{statsFile}` token; the bridge substitutes it
      // with a container-side path at spawn (mirroring how it fills APP_PREAMBLE's
      // bind addr/port/base-path), so workstation agents publish live stats too.
      preamble: `${RECONCILE_PREAMBLE}\n\n${ATLAS_DEV_PREAMBLE}\n\n${STATS_PREAMBLE}\n\n${APP_PREAMBLE}${atlasContext ? `\n\n${atlasContext}` : ''}`,
      model: modelId,
      effort: effortLevel,
      images: imgs,
    },
    BRIDGE_EXEC_TIMEOUT_MS,
    bridge,
  )
  if (r.ok && r.body && r.body.id) {
    if (bridge) idBridge.set(r.body.id, bridge.label) // seed before the first poll
    if (parent) setSpawnParent(r.body.id, parent)
    local.recordSpawn(repo)
    generateTitle(r.body.id, task)
  }
  return { status: r.status, body: r.body }
}

/* --- scheduled agent actions --------------------------------------- *
 * Fire a spawn (a new dev/knowledge agent) or a prompt (input to an existing
 * agent) at a chosen FUTURE time. Each job is the action + the exact payload to
 * replay; a timer fires those whose time has come, then drops them. The store is
 * persisted (scheduled.json) so a job scheduled for a moment while the API was
 * down fires on the next boot. Bearer-gated at the routes; the fire path reuses
 * performSpawn (spawn) and the queue path (prompt) — same audit/allowlist.
 * ------------------------------------------------------------------ */
const SCHEDULED_FILE = path.join(STATE_DIR, 'scheduled.json')
const SCHEDULE_POLL_MS = Number(process.env.AGENT_SCHEDULE_POLL_MS || 5000)
const MAX_SCHEDULED = Number(process.env.AGENT_MAX_SCHEDULED || 100)

function loadScheduled() {
  try {
    const a = JSON.parse(fs.readFileSync(SCHEDULED_FILE, 'utf-8'))
    return Array.isArray(a) ? a : []
  } catch {
    return []
  }
}
let scheduled = loadScheduled()

function persistScheduled() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(SCHEDULED_FILE, JSON.stringify(scheduled))
  } catch (e) {
    console.error('[agent-routes] scheduled persist failed:', e.message)
  }
}

// The lean public shape the dashboard renders (drops nothing sensitive — there
// are no secrets in a job — but keeps the payload tidy). Newest due first.
function publicScheduled() {
  return [...scheduled]
    .sort((a, b) => (a.at < b.at ? -1 : 1))
    .map((j) => ({
      id: j.id,
      action: j.action,
      at: j.at,
      label: j.label || '',
      repo: j.repo,
      vault: j.vault,
      kind: j.kind,
      targetId: j.targetId,
    }))
}

// Deliver a scheduled prompt to whichever executor owns the agent — always via
// the QUEUE path (lands at the agent's next idle, never mid-turn), matching the
// card's gentle "Queue" default. A vanished target just no-ops.
async function deliverScheduledPrompt({ id, text }) {
  if (local.hasSession(id)) return local.queuePrompt({ id, text })
  return callBridgeForId('POST', '/queue', { id, text }, id, BRIDGE_EXEC_TIMEOUT_MS)
}

let firingScheduled = false
async function fireDueScheduled() {
  if (firingScheduled) return
  firingScheduled = true
  try {
    const now = Date.now()
    const due = scheduled.filter((j) => Date.parse(j.at) <= now)
    for (const job of due) {
      // Drop the job from the store BEFORE firing so a slow fire can't be
      // double-fired by the next tick (at-most-once; a crash mid-fire loses it).
      scheduled = scheduled.filter((j) => j.id !== job.id)
      persistScheduled()
      try {
        if (job.action === 'spawn') {
          const r = await performSpawn(job.payload)
          console.log(`[agent-routes] scheduled spawn fired (${job.id}): status ${r.status}`)
        } else if (job.action === 'prompt') {
          await deliverScheduledPrompt(job.payload)
          console.log(`[agent-routes] scheduled prompt fired (${job.id}) → ${job.targetId}`)
        }
      } catch (e) {
        console.error(`[agent-routes] scheduled job ${job.id} failed:`, e?.message || e)
      }
    }
  } finally {
    firingScheduled = false
  }
}
const scheduleTimer = setInterval(() => { fireDueScheduled().catch(() => {}) }, SCHEDULE_POLL_MS)
if (scheduleTimer.unref) scheduleTimer.unref() // don't keep the process alive for this

export function agentRouter(bearerAuth) {
  const router = express.Router()

  // Bundled view — MERGES box-local sessions (always available) with the
  // workstation bridge's (when reachable). `localRepos` lets each card resolve
  // its own bridge's reachability; `workstationReachable` is the remote half;
  // `reachable` (any bridge up) preserves the global card's old contract.
  router.get('/api/agents', async (_req, res) => {
    const localRepos = local.localRepoKeys()
    const localSessions = await local.listSessions()
    // Poll every bridge in parallel; each result keeps its bridge label.
    const polled = await Promise.all(
      bridges().map(async (b) => {
        const r = await callBridge('GET', '/sessions', undefined, BRIDGE_TIMEOUT_MS, b)
        const sessions = r.ok && Array.isArray(r.body.sessions) ? r.body.sessions : []
        // Fold each reachable poll into per-bridge phase tracking — accrues `run`
        // records for monthRunMsByRepo + decorates sessions with their live
        // run-timer fields. Reuses this fetch; no extra bridge call.
        if (r.ok) trackRemotePhases(sessions, b.label)
        return { bridge: b, reachable: r.ok, sessions }
      }),
    )
    const remoteSessions = polled.flatMap((p) => p.sessions)
    lastRemoteSessions = remoteSessions // keep the Atlas ship-note stash fresh
    // Overlay "shipping…" on any remote agent the operator pressed Ship on, until
    // its ATLAS:SHIPPED marker lands — reusing the shipQueue{active} spinner the
    // card already renders (remote has no serial ship train). Drop the flag once
    // shipped or once the session is gone, so the set can't leak.
    const remoteIds = new Set(remoteSessions.map((s) => s && s.id))
    for (const id of [...remoteShipping]) if (!remoteIds.has(id)) remoteShipping.delete(id)
    for (const rs of remoteSessions) {
      if (!rs || !remoteShipping.has(rs.id)) continue
      if (rs.shipState === 'shipped') remoteShipping.delete(rs.id)
      else rs.shipQueue = { pos: 1, active: true }
    }
    // Every workstation dev agent is Atlas-paired for CLOSE purposes — it got an
    // Atlas briefing at spawn and logs a recap to the Atlas on close — so surface
    // the same graceful-close fields box agents carry: the card then uses the
    // two-step ✕ and renders the close phase. No-op (old behaviour) when the atlas
    // isn't configured. `closing`/`closePhase` come from an in-flight remoteClosing.
    if (local.atlasAvailable()) {
      for (const rs of remoteSessions) {
        if (!rs || rs.status === 'done') continue
        rs.atlasWorker = true
        const c = remoteClosing.get(rs.id)
        if (c) {
          rs.closing = true
          rs.closePhase = c.phase
        }
      }
    }
    const bridgeViews = polled.map((p) => ({
      label: p.bridge.label,
      reachable: p.reachable,
      // `repos` stays the ROUTING set (empty = catch-all) so the catch-all
      // detection below and Projects.tsx keep working. `spawnRepos` is the
      // dev-repo keys this bridge ADVERTISES as spawnable — surfaced to
      // orchestrators via list_agents (the catch-all's come from AGENT_BRIDGE_REPOS).
      repos: p.bridge.repos,
      spawnRepos: advertisedRepos(p.bridge),
    }))
    // Back-compat: `workstation`/`workstationReachable` mirror the DEFAULT
    // (catch-all) bridge so existing cards keep working unchanged.
    const def = bridgeViews.find((v) => v.repos.length === 0)
    const workstationReachable = !!def && def.reachable
    // Decorate every session (either bridge) with its spawn-time short title.
    const sessions = withTitles([...localSessions, ...remoteSessions]).sort((a, b) =>
      a.startedAt < b.startedAt ? 1 : -1,
    )
    // Overlay spawn lineage (Atlas orchestrator → the agents it spawned) for the
    // Agent constellation. Both box-local and remote sessions are decorated here.
    for (const s of sessions) {
      const p = spawnParent.get(s.id)
      if (p) s.spawnedBy = p
    }
    res.json({
      generated: new Date().toISOString(),
      reachable: localRepos.length > 0 || bridgeViews.some((v) => v.reachable),
      workstation: defaultLabel(),
      workstationReachable,
      localRepos,
      // Per-bridge reachability + the repos each owns — lets a card resolve its
      // own repo's bridge and show that bridge's status (see Projects.tsx).
      bridges: bridgeViews,
      // Persistent recency floor per repo — outlives session removal so cards
      // stay ranked by past dev-agent activity (see local.recordSpawn).
      lastSpawn: local.lastSpawnMap(),
      // Dev-agent working time this calendar month, per repo — the project cards
      // show their own repo's total. Box-local agents are instrumented directly;
      // remote agents via the per-bridge phase shadows (trackRemotePhases above).
      monthRunMsByRepo: local.monthRunMsByRepo(),
      sessions,
      // Pending scheduled actions (spawns + prompts) waiting for their due time.
      // The card renders each as a ⏱ chip / pending row with a cancel button.
      scheduled: publicScheduled(),
    })
  })

  // Aggregate dev/knowledge-agent time-tracking history. Read-only, like GET
  // /api/agents. Box-local agents plus workstation agents (tracked via the remote
  // phase shadows) share the one on-box timings log.
  router.get('/api/agent-stats', (_req, res) => {
    res.json(local.agentStats())
  })

  // Reply with a box-local executor result in the {status, ...body} shape the
  // bridge proxy already uses.
  const sendLocal = (res, r) => {
    const { status, ...body } = r
    res.status(status).json(body)
  }

  // The spawn route opts out of the global 32kb parser (LARGE_BODY_ROUTES in
  // server.mjs) so it can carry base64 image attachments for the opening prompt;
  // parse it here with the same roomier limit prompt/interrupt/queue use.
  // The spawn flow lives in performSpawn (module scope) so the scheduler can
  // replay it; the route is a thin wrapper that returns its { status, body }.
  router.post('/api/agents/spawn', jsonPrompt, bearerAuth, async (req, res) => {
    const { status, body } = await performSpawn(req.body || {})
    res.status(status).json(body)
  })

  // Schedule a spawn or a prompt for a future time. Body:
  //   { action: 'spawn', at, payload: { task, repo|kind/vault, model?, effort? } }
  //   { action: 'prompt', at, payload: { id, text } }
  // `at` is an ISO timestamp (must be in the future). The job is stored and fired
  // by the scheduler timer at its due time — spawn replays performSpawn, prompt
  // queues to the agent. Returns the new job's id. Text-only (no attachments).
  router.post('/api/agents/schedule', bearerAuth, (req, res) => {
    const { action, at, payload } = req.body || {}
    if (action !== 'spawn' && action !== 'prompt')
      return res.status(400).json({ ok: false, error: 'action must be "spawn" or "prompt"' })
    const when = typeof at === 'string' ? Date.parse(at) : NaN
    if (!Number.isFinite(when)) return res.status(400).json({ ok: false, error: 'invalid "at" (expected an ISO timestamp)' })
    if (when <= Date.now()) return res.status(400).json({ ok: false, error: '"at" must be in the future' })
    if (!payload || typeof payload !== 'object') return res.status(400).json({ ok: false, error: 'missing "payload"' })
    if (scheduled.length >= MAX_SCHEDULED) return res.status(409).json({ ok: false, error: `too many scheduled jobs (max ${MAX_SCHEDULED})` })

    const job = { id: `sch-${when.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, action, at: new Date(when).toISOString(), createdAt: new Date().toISOString() }
    if (action === 'spawn') {
      const { task, repo, model, effort, kind, vault, parent } = payload
      if (!task || typeof task !== 'string') return res.status(400).json({ ok: false, error: 'spawn payload needs "task"' })
      if (kind !== undefined && kind !== 'knowledge') return res.status(400).json({ ok: false, error: 'unknown "kind" (expected knowledge)' })
      if (kind !== 'knowledge' && (!repo || typeof repo !== 'string')) return res.status(400).json({ ok: false, error: 'spawn payload needs "repo"' })
      if (model !== undefined && !AGENT_MODELS[model]) return res.status(400).json({ ok: false, error: 'unknown "model"' })
      if (effort !== undefined && !AGENT_EFFORTS.has(effort)) return res.status(400).json({ ok: false, error: 'unknown "effort"' })
      job.payload = { task, ...(repo ? { repo } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(kind ? { kind } : {}), ...(vault ? { vault } : {}), ...(parent ? { parent } : {}) }
      job.label = task.slice(0, 200)
      if (repo) job.repo = repo
      if (vault) job.vault = vault
      if (kind) job.kind = kind
    } else {
      const { id, text } = payload
      if (!id || typeof id !== 'string') return res.status(400).json({ ok: false, error: 'prompt payload needs "id"' })
      if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ ok: false, error: 'prompt payload needs "text"' })
      job.payload = { id, text }
      job.targetId = id
      job.label = text.slice(0, 200)
    }
    scheduled.push(job)
    persistScheduled()
    res.json({ ok: true, id: job.id, at: job.at })
  })

  // Cancel a pending scheduled job (the ⏱-pending chip's ×).
  router.post('/api/agents/unschedule', bearerAuth, (req, res) => {
    const { id } = req.body || {}
    if (!id || typeof id !== 'string') return res.status(400).json({ ok: false, error: 'missing "id"' })
    const before = scheduled.length
    scheduled = scheduled.filter((j) => j.id !== id)
    if (scheduled.length === before) return res.status(404).json({ ok: false, error: 'no such scheduled job' })
    persistScheduled()
    res.json({ ok: true })
  })

  // Validate an { id, text, images? } body shared by prompt/interrupt/queue (all
  // three carry the same shape and the same image cap). Writes the 400 and returns
  // null on rejection; returns the normalized body on success.
  const promptBody = (req, res) => {
    const { id, text, images, steeredBy } = req.body || {}
    if (!id || typeof id !== 'string') {
      res.status(400).json({ ok: false, error: 'missing "id"' })
      return null
    }
    const imgs = Array.isArray(images) ? images : []
    const hasText = typeof text === 'string' && text.length > 0
    if (!hasText && !imgs.length) {
      res.status(400).json({ ok: false, error: 'missing "text" or "images"' })
      return null
    }
    if (imgs.length > MAX_IMAGES) {
      res.status(400).json({ ok: false, error: `too many files (max ${MAX_IMAGES})` })
      return null
    }
    if (imgs.some((im) => !im || typeof im.dataUrl !== 'string')) {
      res.status(400).json({ ok: false, error: 'each attachment needs a "dataUrl"' })
      return null
    }
    // `steeredBy` (an Atlas orchestrator's session id) rides along on the MCP
    // steer tools so the target's chat view can color an agent-injected prompt
    // apart from the operator's; the dashboard UI never sets it.
    const out = { id, text: hasText ? text : '', images: imgs }
    if (typeof steeredBy === 'string' && steeredBy) out.steeredBy = steeredBy
    return out
  }

  router.post('/api/agents/prompt', jsonPrompt, bearerAuth, async (req, res) => {
    const body = promptBody(req, res)
    if (!body) return
    // `force` bypasses the pending-choice-menu guard — set by the card's "dismiss
    // menu & send" after it has Escaped the menu (see local/bridge prompt()).
    body.force = !!(req.body && req.body.force)
    if (local.hasSession(body.id)) return sendLocal(res, await local.prompt(body))
    const r = await callBridgeForId('POST', '/prompt', body, body.id, BRIDGE_EXEC_TIMEOUT_MS)
    res.status(r.status).json(r.body)
  })

  // Interrupt the in-flight turn and steer with the given context (Esc, then send;
  // the running turn's work so far is kept). Same body shape as prompt.
  router.post('/api/agents/interrupt', jsonPrompt, bearerAuth, async (req, res) => {
    const body = promptBody(req, res)
    if (!body) return
    if (local.hasSession(body.id)) return sendLocal(res, await local.interrupt(body))
    const r = await callBridgeForId('POST', '/interrupt', body, body.id, BRIDGE_EXEC_TIMEOUT_MS)
    res.status(r.status).json(r.body)
  })

  // Queue a prompt for delivery when the session next goes idle (true end-of-turn).
  router.post('/api/agents/queue', jsonPrompt, bearerAuth, async (req, res) => {
    const body = promptBody(req, res)
    if (!body) return
    if (local.hasSession(body.id)) return sendLocal(res, await local.queuePrompt(body))
    const r = await callBridgeForId('POST', '/queue', body, body.id, BRIDGE_EXEC_TIMEOUT_MS)
    res.status(r.status).json(r.body)
  })

  // Enqueue a ship into the SERIAL ship train (box-local) so several "ready"
  // agents merge one at a time — each re-syncs onto the previous merge — instead
  // of racing the shared /workspace/.git or landing un-integrated on master. The
  // card sends the ship prompt as `text`; the executor delivers it when this
  // member reaches the front and the session is idle, then watches for
  // ATLAS:SHIPPED before advancing. Workstation agents (no on-box transcript to
  // watch) fall back to the plain queued ship prompt — unchanged, concurrent.
  router.post('/api/agents/ship', bearerAuth, async (req, res) => {
    const { id, text } = req.body || {}
    if (!id || typeof id !== 'string') return res.status(400).json({ ok: false, error: 'missing "id"' })
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ ok: false, error: 'missing "text"' })
    if (local.hasSession(id)) return sendLocal(res, local.enqueueShip({ id, text }))
    // Remote: no serial ship train — just queue the ship prompt to the bridge, and
    // mark the agent "shipping" so GET overlays the spinner until it prints SHIPPED.
    const r = await callBridgeForId('POST', '/queue', { id, text }, id, BRIDGE_EXEC_TIMEOUT_MS)
    if (r.status >= 200 && r.status < 300) remoteShipping.add(id)
    res.status(r.status).json(r.body)
  })

  // Remove a not-yet-shipping agent from the ship train (cancel before it ships).
  router.post('/api/agents/unship', bearerAuth, async (req, res) => {
    const { id } = req.body || {}
    if (!id || typeof id !== 'string') return res.status(400).json({ ok: false, error: 'missing "id"' })
    if (local.hasSession(id)) return sendLocal(res, local.unship({ id }))
    remoteShipping.delete(id) // clear the "shipping" overlay on a remote cancel
    const r = await callBridgeForId('POST', '/unqueue', { id }, id, BRIDGE_EXEC_TIMEOUT_MS)
    res.status(r.status).json(r.body)
  })

  // Cancel a session's queued prompt(s). With a numeric `index`, drop just that
  // one from the FIFO queue; without one, clear the whole queue.
  router.post('/api/agents/unqueue', bearerAuth, async (req, res) => {
    const { id, index } = req.body || {}
    if (!id || typeof id !== 'string') return res.status(400).json({ ok: false, error: 'missing "id"' })
    const idx = typeof index === 'number' ? index : undefined
    if (local.hasSession(id)) return sendLocal(res, await local.unqueue({ id, index: idx }))
    const r = await callBridgeForId('POST', '/unqueue', { id, ...(idx !== undefined ? { index: idx } : {}) }, id, BRIDGE_EXEC_TIMEOUT_MS)
    res.status(r.status).json(r.body)
  })

  // Send a session's queued prompt NOW — interrupt the in-flight turn and deliver
  // the parked prompt immediately, instead of waiting for the turn to finish.
  router.post('/api/agents/send-now', bearerAuth, async (req, res) => {
    const { id } = req.body || {}
    if (!id || typeof id !== 'string') return res.status(400).json({ ok: false, error: 'missing "id"' })
    if (local.hasSession(id)) return sendLocal(res, await local.sendNow({ id }))
    const r = await callBridgeForId('POST', '/send-now', { id }, id, BRIDGE_EXEC_TIMEOUT_MS)
    res.status(r.status).json(r.body)
  })

  // Drive an interactive TUI menu: send navigation/confirm keys (Up/Down/Enter/
  // Escape/digits) so you can pick an option or accept from the card. Routed to
  // whichever executor owns the id, like prompt/kill.
  router.post('/api/agents/keys', bearerAuth, async (req, res) => {
    const { id, keys } = req.body || {}
    if (!id || typeof id !== 'string') return res.status(400).json({ ok: false, error: 'missing "id"' })
    if (!Array.isArray(keys) || !keys.length) return res.status(400).json({ ok: false, error: 'missing "keys"' })
    if (local.hasSession(id)) return sendLocal(res, await local.keys({ id, keys }))
    const r = await callBridgeForId('POST', '/keys', { id, keys }, id, BRIDGE_EXEC_TIMEOUT_MS)
    res.status(r.status).json(r.body)
  })

  router.post('/api/agents/kill', bearerAuth, async (req, res) => {
    const { id } = req.body || {}
    if (!id || typeof id !== 'string') return res.status(400).json({ ok: false, error: 'missing "id"' })
    if (local.hasSession(id)) return sendLocal(res, await local.kill({ id }))
    // Remote Atlas-paired agent: first ✕ runs the graceful recap → Atlas ingest in
    // the background and kills on the bridge when done; a second ✕ force-kills here.
    const closing = await startRemoteAtlasClose(id, false)
    if (closing) return res.json(closing)
    const r = await callBridgeForId('POST', '/kill', { id }, id, BRIDGE_EXEC_TIMEOUT_MS)
    res.status(r.status).json(r.body)
  })

  // Destructive: kill + remove the worktree + delete the agent/<id> branch.
  router.post('/api/agents/cleanup', bearerAuth, async (req, res) => {
    const { id } = req.body || {}
    if (!id || typeof id !== 'string') return res.status(400).json({ ok: false, error: 'missing "id"' })
    if (local.hasSession(id)) return sendLocal(res, await local.cleanup({ id }))
    // Same graceful recap → ingest as ✕, but the bridge teardown removes the
    // worktree + branch when it finishes (a second ⌦ forces the immediate cleanup).
    const closing = await startRemoteAtlasClose(id, true)
    if (closing) return res.json(closing)
    const r = await callBridgeForId('POST', '/cleanup', { id }, id, BRIDGE_EXEC_TIMEOUT_MS)
    res.status(r.status).json(r.body)
  })

  // Revive a dormant box-local agent — relaunch its Claude session on the existing
  // worktree (the card's Revive button). Box-local ONLY: a dormant agent is one a
  // tmux-server death stranded on THIS box; bridge agents don't go dormant this way.
  // Memory-gated server-side so a click can't OOM the RAM-bound box.
  router.post('/api/agents/revive', bearerAuth, async (req, res) => {
    const { id } = req.body || {}
    if (!id || typeof id !== 'string') return res.status(400).json({ ok: false, error: 'missing "id"' })
    if (!local.hasSession(id)) return res.status(404).json({ ok: false, error: 'revive is box-local only — no such local session' })
    sendLocal(res, await local.revive({ id }))
  })

  // Memory-aware bulk revive ("Revive all"): bring back every dormant box-local
  // agent that still fits in RAM (newest first, staggered; stops before the box
  // runs low). Returns { revived, held }.
  router.post('/api/agents/revive-all', bearerAuth, async (_req, res) => {
    sendLocal(res, await local.reviveAll())
  })

  // Abort an in-flight graceful close — the operator pressed ✕/⌦ (often on the
  // wrong agent) and wants it back. Stops the wrap-up and clears the close markers
  // WITHOUT killing/removing anything; the agent keeps running.
  router.post('/api/agents/abort-close', bearerAuth, async (req, res) => {
    const { id } = req.body || {}
    if (!id || typeof id !== 'string') return res.status(400).json({ ok: false, error: 'missing "id"' })
    if (local.hasSession(id)) return sendLocal(res, await local.abortClose({ id }))
    // Remote Atlas-paired agent mid-close: drop the close marker so the background
    // recap→ingest→teardown loop unwinds without killing the agent on its bridge
    // (captureRemoteRecap bails and the teardown is guarded on the marker).
    if (remoteClosing.has(id)) {
      remoteClosing.delete(id)
      return res.json({ ok: true })
    }
    return res.status(409).json({ ok: false, error: 'not closing' })
  })

  // Fuller output capture for one session — the card's expand-transcript view.
  // Routed to whichever executor owns the id. Read-only (like GET /api/agents).
  router.get('/api/agents/output', async (req, res) => {
    const id = String(req.query.id || '')
    if (!id) return res.status(400).json({ ok: false, error: 'missing "id"' })
    const lines = Math.min(Math.max(Number(req.query.lines) || 200, 1), 2000)
    if (local.hasSession(id)) return sendLocal(res, await local.output({ id, lines }))
    const r = await callBridge('GET', `/output?id=${encodeURIComponent(id)}&lines=${lines}`, undefined, BRIDGE_TIMEOUT_MS, bridgeForId(id))
    if (!r.ok) return res.status(r.status).json({ ok: false, error: r.body?.error || 'bridge unreachable' })
    res.json(r.body)
  })

  // Full chat history for one session — parsed from Claude Code's on-disk `.jsonl`
  // transcript(s), stitched across resume-forked files. This is the COMPLETE
  // conversation (the card's "Full history" toggle), where /output is only the live
  // tmux pane. Read-only; routed to whichever executor owns the id.
  router.get('/api/agents/history', async (req, res) => {
    const id = String(req.query.id || '')
    if (!id) return res.status(400).json({ ok: false, error: 'missing "id"' })
    // `rev`: the fingerprint the caller last saw — lets the live poll answer
    // `unchanged` without re-reading/re-sending the whole conversation.
    const rev = String(req.query.rev || '')
    if (local.hasSession(id)) return sendLocal(res, await local.history({ id, rev }))
    const r = await callBridge('GET', `/history?id=${encodeURIComponent(id)}${rev ? `&rev=${encodeURIComponent(rev)}` : ''}`, undefined, BRIDGE_TIMEOUT_MS, bridgeForId(id))
    if (!r.ok) return res.status(r.status).json({ ok: false, error: r.body?.error || 'bridge unreachable' })
    res.json(r.body)
  })

  return router
}
