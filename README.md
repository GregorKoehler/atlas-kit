# Atlas Kit

**A self-hosted runtime that drives an [Atlas](https://github.com/GregorKoehler/llm-atlas)
knowledge vault with Claude Code agents.** A glass-HUD dashboard, dev + knowledge
agents running in tmux, and a task Kanban — all wired to a single markdown vault.

> **Atlas Kit is the harness; [llm-atlas](https://github.com/GregorKoehler/llm-atlas)
> is the knowledge-base template it pairs with.** The Atlas is an agent-maintained,
> typed, queryable markdown wiki (Karpathy's LLM-wiki pattern + a relational overlay).
> Atlas Kit is what runs *around* it: the dashboard, the agent orchestration, and the
> box setup. Atlas Kit does **not** ship a vault — you create yours from the llm-atlas
> template and point `VAULT_PATH` at it.

Extracted and generalized from a larger personal command-center ("Gravis"), pared
down to the pieces worth reusing.

<!-- screenshots: replace these with your own -->
<!-- ![Home tab — project cards + scorecard + Atlas agent](docs/screenshots/home.png) -->
<!-- ![Atlas tab — Kanban + graph + reader](docs/screenshots/atlas.png) -->
<!-- ![A dev agent's live transcript + PR ship flow](docs/screenshots/agent.png) -->

---

## The six pillars

### 1. Dev agents in tmux via Claude Code — the core
Spawn a Claude Code session in a `tmux` window on a repo, drive it, and watch its
transcript live. Each agent gets its own **`git worktree`** on an `agent/<id>`
branch. You can **prompt** it, **queue** a message (lands at its next idle),
**schedule** one for a future time, **interrupt & steer** a running turn, **kill**
(keep the worktree for review), or **cleanup** (remove worktree + branch). Idle vs.
busy is detected from the terminal; numbered menus are answerable from the card.
Extracted from the Gravis agent runtime — simplified but functional.

### 2. Knowledge-base coupling
The workflow where dev agents (a) **search the vault first** before starting work,
(b) work, and (c) on close **commit their insights back** into the Atlas — a project
page update, a `Wiki/log.md` entry, a filed `Tasks/` item. A paired knowledge worker
briefs the dev agent from the vault at spawn and ingests its recap the typed way at
cleanup. All the prompt scaffolding for this ships here, generalized to *your* vault.

### 3. Kanban coupled to the KB
A drag-and-drop **Kanban** over the vault's `Tasks/` (`type: task`, status
`inbox | next | doing | waiting | done`). **Every** change — including a status drag —
commits through a **serial git commit queue** (`pull --rebase --autostash` → edit →
commit → push, with lock-race + non-fast-forward retries), so concurrent writes never
race the one checkout. A daily cron **archives** completed tasks off the board (kept in
git history, never deleted).

### 4. Knowledge agents
Chat-over-the-vault agents that answer grounded in the KB (with citations), can kick
off research, and — as the **orchestrator** — can spawn and steer the dev agents. This
is the Atlas-agent pattern, including its **MCP control surface**: `list_agents`,
`agent_transcript`, `spawn_agent`, `prompt_agent`, `queue_agent`, `interrupt_agent`,
`kill_agent`, `cleanup_agent`, plus `query_vault` (fuzzy full-text) and `query_atlas`
(exact relational/temporal queries over the typed layer).

### 5. Git workflow
One **`git worktree` per dev agent**, a **branch per agent**, and a strict
**rebase-before-push** discipline (`git pull --rebase --autostash` before any push).
Vault log files use `*.md merge=union` so append-only history (`log.md`, `index.md`)
merges without conflicts across writers (your phone's Obsidian Git, an agent, the
Kanban). See **[Git workflow](#git-workflow-1)** below.

### 6. Main page with project cards
One card per project showing its dev agents with spawn buttons — including **remote
spawn** via a bridge (the workstation-over-Tailscale pattern, `bridges.json`). Kept
visually close to the source: the **scorecard**, the **Atlas search**, the **hero
overview**, and the **glass-HUD** look (Tailwind + CSS-variable design tokens).

---

## Dev agents vs. knowledge agents

They share the same access primitives (both run `claude` in a `tmux` window on the box,
both appear on `GET /api/agents`, both use the same transcript UI) — but the **contract
differs**:

| | **Dev agent** | **Knowledge agent** |
|---|---|---|
| Lives in | a `git worktree` of **one repo**, on an `agent/<id>` branch | the **vault** root (no branch) |
| Output | code → opens a **PR**, ships it | vault pages (add-and-link), `Tasks/`, `log.md` |
| Role | do a scoped engineering task | **answer, research, and orchestrate** the others |
| Extras | ship/sync buttons, live-app preview | MCP agent-control tools (spawn/steer/kill) |

In short: a **dev agent** is a coding worker isolated to a branch of one repo; a
**knowledge agent** lives over the vault, answers from it, writes durable knowledge
back, and — on the vault keyed `atlas` — becomes mission control for the fleet. The
distinction is exactly the two different *contracts* layered on the same runtime.

---

## Architecture

```
web/          Vite + Preact + TypeScript dashboard (glass-HUD; one file per card)
  src/components/cards/   Projects, Scorecard, Hero, Kanban, KnowledgeAgents, AgentList, …
  src/lib/api.ts          the single /api client (one API_BASE)
  src/styles/             design tokens (CSS vars) + Tailwind
api/          Express API + the agent runtime + the MCP server
  src/agent-local.mjs     box-local executor (git worktree + tmux + claude, directly)
  src/agent-routes.mjs    /api/agents/* routes + the agent preambles
  src/atlas-commit-queue.mjs   the serial vault commit queue (pillar 3 + 5)
  src/atlas-query.mjs     the typed relational/temporal query engine (query_atlas)
  src/read-routes.mjs     open GET reads: notes, wiki, search, tasks, projects
  src/atlas-routes.mjs    Kanban task writes (bearer-gated, via the commit queue)
  src/mcp/                the MCP server (query_vault/query_atlas + agent control)
  src/bridges.mjs         repo → remote-bridge routing
agent-bridge/ Host-native bridge to drive agents in remote dev containers (Tailscale)
scripts/      serve.sh (tmux service manager), refresh-atlas, clear-done, provisioning
infra/        Caddyfile.example, cloudflared-config.example.yml, atlas-kit.cron
```

**Request/auth model:** the browser talks to Caddy on one origin. Read routes are open
(Cloudflare Access gates identity at the edge); every write/exec route is **bearer-gated**,
and Caddy injects `DASHBOARD_BEARER_TOKEN` server-side so the browser never holds it. The
Express API binds `127.0.0.1` only. LLM calls shell out to the **`claude` CLI on your
subscription** — no API keys.

---

## Git workflow

This is a headline feature, not an implementation detail:

- **One worktree + one branch per dev agent.** `spawn` runs `git worktree add -b
  agent/<id> <path>` off the repo, so parallel agents on the same repo never stomp each
  other's working tree; they share one `.git`. `kill` keeps the worktree/branch for
  review; `cleanup` removes them.
- **Rebase before every push.** Agents are steered (via their preamble) to
  `git fetch` → `git rebase origin/<main>` → `git push --force-with-lease`, and to
  re-sync on a fresh fetch before merging a PR. The executor itself never pushes — a
  human (or the orchestrator) drives merges.
- **Serial commit queue for the vault.** All vault writes (Kanban drags, agent
  ingests, the done-clear cron) funnel through one in-process mutex that does
  `pull --rebase --autostash` → mutate → commit → push, with retries for lock races and
  non-fast-forward pushes.
- **`*.md merge=union` for logs.** Add a `.gitattributes` with `*.md merge=union` to
  your vault (the llm-atlas template already does) so append-only files like `log.md`
  and `index.md` merge cleanly across your phone, agents, and the Kanban.

---

## Quick start (local dev)

Requirements: **Node ≥ 20**, **`tmux`**, and the **`claude` CLI** logged in on your
subscription (`claude` → `/login`). You also need a vault — create one from the
[llm-atlas template](https://github.com/GregorKoehler/llm-atlas) (or point at any
folder with `Wiki/` + `Tasks/`).

```bash
git clone https://github.com/GregorKoehler/atlas-kit && cd atlas-kit
cp .env.example .env          # set VAULT_PATH + DASHBOARD_BEARER_TOKEN (openssl rand -hex 32)
npm run install:all           # installs api/ and web/ deps
npm run dev                   # Express API + Vite dev server → http://127.0.0.1:5173
```

To spawn a **box-local dev agent**, copy `api/src/agent-local-repos.example.json` to
`api/src/agent-local-repos.json` and add a repo you have checked out on this machine
(this is the spawn allowlist — the security boundary). The dashboard's project cards
read `Wiki/Projects/*.md` from your vault; give a project page an `agent_repo:` key to
bind it to a spawnable repo.

For production (a Hetzner box behind a Cloudflare Tunnel + Access, systemd, cron,
optional remote bridge), follow **[docs/SETUP.md](docs/SETUP.md)** — a zero-to-running
walkthrough.

---

## What this kit is **not**

Deliberately out of scope (stripped from the source): mail/calendar/news feeds,
recipes + shopping, capture/dictation/voice, Drive/Gmail tooling, daily briefings, and
every card not named above. Smaller is better — this is a starter kit, not the whole
command center.

## License

MIT — see [LICENSE](LICENSE).
