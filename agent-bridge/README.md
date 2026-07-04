# agent-bridge

Host-native service that lets the Atlas Kit dashboard **drive Claude Code sessions
in your local dev containers** — list, watch, prompt, spawn, and kill them —
without exposing the workstation. The setup walkthrough lives in
[`docs/SETUP.md`](../docs/SETUP.md); this is the operational README.

```
box (public, dashboard)  ──Tailscale tailnet──►  workstation host
                                                    │ agent-bridge (this)
                                                    │   docker exec ↓
                                                    └─ dev containers (tmux + git + claude + gh)
```

The bridge holds docker access (**≈ root on the workstation — protect it
hardest**) and is dependency-free (`node:` builtins only), so install is a clone +
a systemd unit, no `npm install`. It needs **Node ≥18** (the installer refuses
older); on distros whose system node is ancient (Ubuntu 20.04 ships v10), drop in
a standalone tarball and point the installer at it:
`sudo NODE_BIN=/opt/node20/bin/node scripts/install-agent-bridge.sh`.

## What it does

Each `spawn` creates a fresh `git worktree` on an `agent/<id>` branch inside the
target container (isolated working dir, shared `.git`) and starts a detached tmux
session running Claude Code there. Parallel agents in one repo don't stomp each
other; you review/merge each branch. `kill` ends the tmux session but **leaves the
worktree + branch in place** for review.

## API (bearer on every request; bind tailnet-only)

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/health` | — | open (no auth) |
| GET | `/sessions` | — | `{ generated, sessions:[{id,task,repo,branch,status,lastOutput,startedAt}] }` |
| GET | `/output?id=&lines=` | — | larger tmux capture for one session |
| POST | `/spawn` | `{task, repo, preamble?}` | `repo` is a KEY in `repos.json`; `preamble` (optional) is appended to the agent's prompt (slug/branch still from `task`); returns `{ok,id}` |
| POST | `/prompt` | `{id, text, images?}` | `tmux send-keys` (literal); `images` are `data:`-URL uploads streamed into the container and referenced by path |
| POST | `/kill` | `{id}` | ends tmux; worktree/branch persist |
| POST | `/cleanup` | `{id}` | ends tmux **and** removes the worktree + deletes the `agent/<id>` branch (for merged/abandoned work) |
| ALL | `/agent-app/<repo>/…` | — | reverse-proxy (HTTP + WebSocket) to the live app an agent runs in the container, reached via that container's already-published port (`docker port`); path preserved for Streamlit's `--server.baseUrlPath`. `/sessions` carries `appPath` + `appUp` per session |

`status`: `running` (tmux session alive) · `done` (exited) · `error` (spawn
failed). `running` vs `idle` isn't distinguished yet (open question in the
HANDBOOK roadmap).

## Config

- **`repos.json`** (copy from `repos.example.json`) — the spawn allowlist:
  `{ "<key>": { "container": "<docker name>", "path": "<repo path in container>", "worktreeBase"?: "<dir>" } }`.
  A `repo` not listed here is rejected. This is the spawn security boundary.
  `worktreeBase` defaults to `<path>/.agent-worktrees` (inside the repo, usually
  writable by the dev user); override it if the repo dir isn't writable by the
  container's exec user. `appPort` (optional, default `8501`) is the container-
  INTERNAL port an agent serves its live app on; the bridge reaches it via that
  port's already-PUBLISHED host mapping — confirm one exists with `docker port
  <container>` (no republish / restart needed).
  **Project-card binding.** A project's Obsidian page opts into its dashboard agent
  surface by declaring `agent_repo: <this key>` in frontmatter; the per-project card
  then filters sessions (`s.repo === agent_repo`) and spawns scoped (`repo:
  agent_repo`). Keep the key equal to the project's `tag` where you can (predictable
  keys). (The dashboard can't read the vault's project page directly, so
  `agent_repo` is the explicit per-project enable signal.)
- **`bridge.env`** (written by the installer; gitignored) — runtime env:

  | Var | Default | Meaning |
  |---|---|---|
  | `BRIDGE_TOKEN` | — (required) | bearer; refuses to start if unset |
  | `BRIDGE_HOST` | `127.0.0.1` | bind addr — set to the **tailnet IP** |
  | `BRIDGE_PORT` | `7878` | |
  | `AGENT_LAUNCH_CMD` | `IS_SANDBOX=1 claude --dangerously-skip-permissions {task}` | `{task}` is shell-escaped before substitution |
  | `BRIDGE_REPOS` / `BRIDGE_STATE` / `BRIDGE_AUDIT_LOG` | alongside `server.mjs` | file paths |
  | `BRIDGE_EXEC_TIMEOUT_MS` | `15000` | per `docker exec` |

## Install (on the workstation)

```bash
git clone <this repo> && cd <repo>
sudo scripts/install-agent-bridge.sh     # seeds config, binds tailnet IP, installs systemd unit
$EDITOR agent-bridge/repos.json          # map your repos → {container, path}
sudo systemctl restart atlas-kit-agent-bridge
journalctl -u atlas-kit-agent-bridge -f
```

**Redeploy** (pick up new bridge code after it lands on master, or just bounce it):

```bash
sudo scripts/restart-agent-bridge.sh             # git pull --ff-only → restart → health check
sudo scripts/restart-agent-bridge.sh --no-pull   # restart only (e.g. after editing repos.json)
```

Then on the **box**, set in the dashboard `.env` (and `serve.sh restart`):

```
AGENT_BRIDGE_URL=http://<workstation-tailnet-ip>:7878
AGENT_BRIDGE_TOKEN=<the same BRIDGE_TOKEN>
```

## Provisioning a dev-agent container

The bridge **drives** containers (`docker exec`); it does **not** provision them.
Each container in `repos.json` must ship the agent toolchain, or a spawn dies at
`docker exec … tmux new-session`:

- **tmux + git** — the bridge runs the agent in a `tmux` session inside a `git
  worktree`.
- **the Claude Code CLI (`claude`)** — the launch command (`AGENT_LAUNCH_CMD`)
  runs it. Authenticate it **inside the container**: use the
  **subscription** (mount the host `~/.claude` so `.credentials.json` persists; a
  one-time `claude login` seeds it), with `ANTHROPIC_API_KEY` left blank so it
  can't fall back to API billing.
- **the GitHub CLI (`gh`) + git auth** — so agents push branches and open PRs
  unattended. Use a **long-lived classic PAT as `GH_TOKEN`** (env), with git's
  HTTPS credential helper routed through `gh` (`gh auth git-credential`) — **not**
  an interactive `gh auth login` (those tokens expire and break agents mid-push).

Bake these into the container **image** (not a hand-install into a running
container, which a recreate wipes). The pattern: a detached,
`--restart unless-stopped` container with the toolchain (tmux + git + node +
claude + gh) baked into the image and auth wired at runtime (mount `~/.claude`,
set `GH_TOKEN`).

## Multiple bridges

A second box (e.g. `my-box`) runs its **own** copy of this bridge — same code,
its own `repos.json`, its own `BRIDGE_TOKEN`, bound to its own tailnet IP. Register
it dashboard-side in `api/src/bridges.json` (`{ label, url, token, repos:[…] }`, see
`bridges.example.json`): repos listed there route to that bridge; everything else
stays on the default (legacy `AGENT_BRIDGE_URL`) workstation bridge. The bridge code
itself is unchanged.

## Security checklist

- Cloudflare Access in front of the dashboard (mandatory).
- Bearer on every bridge request; **separate** token from the dashboard bearer.
- Bind the tailnet IP only + a Tailscale ACL — never the home LAN / `0.0.0.0`.
- Spawns allowlisted to `repos.json`; `task` → strict slug; no user string
  reaches a host shell unescaped (docker/git/tmux are arg-arrays; the lone shell
  hop has the task single-quoted).
- Append-only audit log of every spawn/prompt/kill.
- Run dev containers non-privileged; worktrees/branches bound the blast radius.
