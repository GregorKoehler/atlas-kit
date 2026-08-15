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
| GET | `/health` | — | open (no auth) — `{ok, service, sha, features, capacity}`. `sha` is the running commit (so a redeploy is verifiable); `capacity` is this box's own spawn-admission reading (below) — its ABSENCE is how the dashboard detects a bridge that predates capacity reporting |
| GET | `/sessions` | — | `{ generated, sessions:[{id,task,repo,branch,status,lastOutput,startedAt}] }` |
| GET | `/output?id=&lines=` | — | larger tmux capture for one session |
| POST | `/spawn` | `{task, repo, preamble?}` | `repo` is a KEY in `repos.json`; `preamble` (optional) is appended to the agent's prompt (slug/branch still from `task`); returns `{ok,id}` — or **503 with `capacity`** when this box has no room, refused before a worktree, port or container file exists |
| POST | `/prompt` | `{id, text, images?}` | `tmux send-keys` (literal); `images` are `data:`-URL uploads streamed into the container and referenced by path |
| POST | `/kill` | `{id}` | ends tmux; worktree/branch persist |
| POST | `/cleanup` | `{id}` | ends tmux **and** removes the worktree + deletes the `agent/<id>` branch (for merged/abandoned work) |
| POST | `/redeploy` | — | pulls this checkout and restarts this bridge's own service, via a transient `systemd-run` unit so it survives the restart it triggers. The dashboard's "Redeploy bridge" button |
| GET | `/redeploy-status` | — | `{redeploy: {phase, step, sha, at}}` — the phase file the restart script writes |
| POST | `/outbox` | `{verdicts?}` | the box drains parked agent mail + Atlas queries here and posts back the verdicts for the batch it took last. Draining is destructive |
| POST | `/api/agents/message` | `{to, text}` | a CONTAINER agent's peer mail — authed by **its own** `$ATLAS_AGENT_TOKEN`, not the bridge bearer, so it is handled BEFORE the bearer gate. Parked and blocked on the box's verdict |
| POST | `/api/atlas/query` | `{tool, args}` | a CONTAINER agent's READ-ONLY vault query, same scoped-token auth and the same park-and-drain relay. Everything that bounds it lives on the box |
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
  | `BRIDGE_PULL_USER` | — | whose gh/git auth `POST /redeploy` pulls with (it runs as root with no `SUDO_USER`). Set it to your own user, e.g. `BRIDGE_PULL_USER=<your-user>`; without it a phone-triggered redeploy refuses loudly rather than hanging on a credential prompt |
  | `BRIDGE_REDEPLOY_STATE` / `BRIDGE_REDEPLOY_LOG` | `/tmp/atlas-kit-bridge-redeploy-state.json` / `.log` | where the redeploy writes its phase + output |
  | `BRIDGE_AGENT_MAX_CONCURRENT` | `8` | this box's ceiling on live agent sessions |
  | `BRIDGE_AGENT_MEM_FLOOR_MB` / `BRIDGE_AGENT_MEM_PER_AGENT_MB` | `1200` / `500` | the memory a spawn needs: floor + one agent's headroom |
  | `BRIDGE_AGENT_MEM_CHARGE_SWAP` | on | charge swap-in-use against availability (below). `0` turns it off in BOTH layers, since the box uses what we report |
  | `BRIDGE_MSG_API` | `http://$BRIDGE_HOST:$BRIDGE_PORT` | where a CONTAINER reaches this bridge for `agent-msg` / `atlas-query` — override if the container can't route to the bind address |
  | `BRIDGE_MSG_VERDICT_MS` / `BRIDGE_MSG_OUTBOX_MAX` | `20000` / `50` | how long a sender waits for the box's verdict; how many parked attempts are held |
  | `BRIDGE_KEEPALIVE_TIMEOUT_MS` | `60000` | idle keep-alive hold (below) |
  | `BRIDGE_BOUNDARY_DELIVERY` | on | kill-switch for mid-turn delivery of queued messages |

## Install (on the workstation)

```bash
git clone <this repo> && cd <repo>
sudo scripts/install-agent-bridge.sh     # seeds config, binds tailnet IP, installs systemd unit
$EDITOR agent-bridge/repos.json          # map your repos → {container, path}
sudo systemctl restart atlas-kit-agent-bridge
journalctl -u atlas-kit-agent-bridge -f
```

**Redeploy** (pick up new bridge code after it lands on the default branch, or just bounce it):

```bash
sudo scripts/restart-agent-bridge.sh             # git pull --ff-only → restart → health check
sudo scripts/restart-agent-bridge.sh --no-pull   # restart only (e.g. after editing repos.json)
```

**Redeploy from the dashboard** (phone-triggered). The same script backs `POST /redeploy`
on the bridge itself, so a bridge can be redeployed without SSH. It runs inside a transient
`systemd-run` unit — that escape is load-bearing: a plain detached child stays in the
bridge's own cgroup, and the script's `systemctl restart` would SIGTERM it right after it
writes its first phase, before the pull ever finished. Set `BRIDGE_PULL_USER` in
`bridge.env` first (the redeploy runs as root, which has no `gh` auth of its own); without
it the script refuses loudly instead of hanging on a credential prompt. `GET /health`
returns the running `sha`, so the dashboard can tell a real redeploy from a bounce that
brought the same code back up.

Then on the **box**, set in the dashboard `.env` (and `serve.sh restart`):

```
AGENT_BRIDGE_URL=http://<workstation-tailnet-ip>:7878
AGENT_BRIDGE_TOKEN=<the same BRIDGE_TOKEN>
```

## Spawn capacity (this box's memory is a bound)

A bridge box is usually **not** a dedicated agent host — it may also run your production
stack, a CI runner and per-PR preview containers. Nothing used to refuse the agent that
tipped it over: the dashboard box had a RAM-aware brake, and the remote path had none, which
is backwards from where the risk is.

Now `POST /spawn` refuses on **this** box's own reading, before it creates a worktree, a
port or a container file, and the numbers are in the refusal. The same reading rides on
`GET /health`, so the dashboard can show a bridge's remaining `slots` *before* an
orchestrator hits the limit — and the same arithmetic runs on both sides
(`api/src/agent-capacity.mjs`, one implementation, three callers).

It reads `MemAvailable` — never `MemFree`, because a busy box is full of reclaimable cache
that isn't really "used" — and by default **charges swap-in-use against availability**. A box
already deep in swap reads healthier than it is: an idle agent's anonymous pages are cold and
swappable, but the moment it takes a turn they must fault back into RAM, competing with
whatever was just admitted. Tune with `BRIDGE_AGENT_*`; the pessimistic read is deliberate.

⚠️ The dashboard-side check **fails open** on a bridge that reports no `capacity` — bridge
code only reaches a machine when that machine is redeployed, so failing closed would turn
this into a fleet-wide spawn outage the moment the box deploys. A bridge that hasn't been
redeployed is therefore **unbounded**: `list_agents` marks it `capacity.known === false` and
names the remedy. Redeploy it.

## Control-plane priority (the bridge must degrade last)

The bridge is *how this box is reached*, and it shares the box with the very workload it
manages. Under heavy load a small box can climb into three-figure load averages with nothing
crashed — every process alive, production still serving — yet answer nothing over the network
for tens of minutes. The workload starves its own control plane.

`install-agent-bridge.sh` therefore writes `Nice=-5`, `CPUWeight=10000` and
`OOMScoreAdjust=-500` into the systemd unit, so the bridge keeps being scheduled and is not
the thing the kernel kills. These live in the **unit**, which the restart script never
touches — so a box whose unit predates them redeploys perfectly and stays unprotected.
`restart-agent-bridge.sh` checks and says which it is; re-run
`sudo scripts/install-agent-bridge.sh` (idempotent) to apply them.

The bridge also holds idle keep-alive sockets for 60 s rather than Node's 5 s default
(`BRIDGE_KEEPALIVE_TIMEOUT_MS`): the box runs its vault retrieval in-process for tens of
seconds immediately before it POSTs `/spawn` on a pooled socket, and at the default the
socket aged out mid-retrieval and every slow-retrieval spawn reset instantly.

## Agent↔agent mail and Atlas queries from a container

Agents in these containers get `agent-msg` and `atlas-query` on their PATH, written by the
bridge at spawn from the same source the box uses — so the command is identical wherever an
agent runs. The box's API is loopback-bound and unreachable from here, so both post to **this
bridge** instead, authed by the session's own scoped token (never the bridge bearer, which
would be spawn/kill on every repo). The bridge parks the attempt and blocks; the box drains
`POST /outbox` on the poll it already runs, decides it, and posts the verdict back.

The bridge decides **nothing** except who sent it. Lineage, send budgets, the attribution
header, the vault-query tool allowlist, the query budget and both logs all live on the box —
see `docs/PROTOCOLS.md` §7. No new listening socket is involved: the box→bridge direction was
never blocked.

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
