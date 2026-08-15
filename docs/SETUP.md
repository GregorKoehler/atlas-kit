# Atlas Kit — setup (zero to running)

This is the exact path from a fresh box to a live, phone-reachable dashboard that can
spawn Claude Code agents. Most of steps 1–9 are automated by
[`scripts/provision-hetzner.sh`](../scripts/provision-hetzner.sh); the human-only bits
(Cloudflare Access, Tailscale) are called out. Local dev is simpler — see the
[Quick start](../README.md#quick-start-local-dev) in the README.

> **Prefer to have an agent drive it?** [docs/SETUP-AGENT.md](SETUP-AGENT.md) is these
> same ten steps written for a Claude Code agent to run for you — bootstrap the `claude`
> CLI, clone the repo, run `claude` in it, and say *"Read docs/SETUP-AGENT.md and set me
> up."* This file is the manual version.

Architecture recap: a **Cloudflare Tunnel** (outbound-only) fronts **Caddy** on
`:8080`; Caddy serves the built app and proxies `/api` to the **Express** API on
`127.0.0.1:3001` (injecting the bearer token on write routes); an **MCP** server runs
on `:3002` for the Claude.ai connector. **Cloudflare Access** gates identity at the
edge. LLM work runs on your **Claude subscription** via the `claude` CLI — no API keys.

---

## 1. Rent a box

- **Provider/OS:** a [Hetzner Cloud](https://www.hetzner.com/cloud) box on **Ubuntu
  24.04** (the reference box; the provisioning script's apt repos are keyed to it).
- **Size for RAM, not CPU.** `claude` runs are I/O-bound on the Anthropic API, so each
  concurrent agent is mostly a waiting process. **8 GB / 4 vCPU / 80 GB** is
  comfortable (Hetzner **CAX21** ARM, or **CX33** x86 — no functional difference);
  4 GB works for a light load. You can rescale RAM up later without re-provisioning.
- ⚠️ **Add swap.** A small box with **no swap** can freeze/OOM when several box-local
  agents run at once. Add a few GB of swap and cap concurrency
  (`AGENT_LOCAL_MAX_CONCURRENT` in `.env`):
  ```bash
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ```

## 2. Base hardening + user

Standard fresh-box hygiene before anything else:

```bash
apt update && apt -y upgrade
# a non-root sudo user for SSH; disable password + root SSH login
adduser you && usermod -aG sudo you
# copy your key to the new user, then in /etc/ssh/sshd_config set:
#   PermitRootLogin no
#   PasswordAuthentication no
systemctl restart ssh
ufw allow OpenSSH && ufw enable        # the tunnel is outbound-only; no 80/443 needed
```

Atlas Kit itself runs as root in the reference setup (the box is single-tenant and the
agents need `gh` push + the subscription); adapt to a service user if you prefer.

## 3. Tailscale (for the optional remote bridge)

Only needed if you'll spawn dev agents in containers on **another** machine (your
workstation). Join both the box and the workstation to a
[Tailscale](https://tailscale.com) tailnet:

```bash
curl -fsSL https://tailscale.com/install.sh | sh && tailscale up
tailscale ip -4      # note each machine's 100.x.y.z address
```

The bridge binds the **tailnet IP only** — never the LAN or `0.0.0.0`. (Skip this step
for a box-local-only setup; the whole bridge layer stays dormant.)

## 4. Cloudflare Tunnel + Access (edge auth)

1. Add your domain to a (free) Cloudflare account and switch its nameservers.
2. On the box, create a named tunnel and write its config from
   [`infra/cloudflared-config.example.yml`](../infra/cloudflared-config.example.yml):
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create atlas-kit                 # -> a <tunnel-id> + creds json
   # write /root/.cloudflared/config.yml from the example (fill <tunnel-id>, <your-domain>)
   cloudflared tunnel route dns atlas-kit dashboard.<your-domain>
   cloudflared tunnel route dns atlas-kit mcp.<your-domain>
   cloudflared service install && systemctl restart cloudflared
   ```
3. In **Cloudflare Zero Trust → Access → Applications**, add two self-hosted apps:
   - `dashboard.<your-domain>` → policy **Allow → your email (Google login)**.
   - `mcp.<your-domain>` → same policy **+ enable Managed OAuth** (redirect URI
     `https://claude.ai/api/mcp/auth_callback`). Copy the app's **AUD tag** and your
     **team domain** (`<team>.cloudflareaccess.com`) into `.env` as `CF_ACCESS_AUD`
     and `CF_ACCESS_TEAM_DOMAIN` — the MCP server verifies the Access JWT as
     defense-in-depth. ⚠️ Both are **required** once the tunnel routes
     `mcp.<your-domain>`: the MCP server refuses to start (non-zero exit, with the
     reason on stderr) if it finds an ingress rule for its port — or a non-loopback
     `MCP_BIND` — while either value is blank. A 127.0.0.1 bind does *not* make it
     unreachable; cloudflared dials loopback. The remote endpoint serves the vault
     READ tools only, never agent control.

Outbound-only: the box never opens 80/443; every request arrives already
identity-checked by Access.

## 5. Caddy reverse proxy

`serve.sh` runs Caddy for you. Just provide the config:

```bash
cp infra/Caddyfile.example infra/Caddyfile
# edit <REPO_ROOT> to the repo path (e.g. /workspace)
```

Caddy binds `:8080`, serves `web/dist`, proxies `/api` + `/agent-app`, and injects
`DASHBOARD_BEARER_TOKEN` on the write routes. `X-Frame-Options: SAMEORIGIN` lets the
dashboard iframe its own live-app preview.

## 6. Node + the systemd services

```bash
cd web && npm ci && npm run build && cd ..
cd api && npm ci && cd ..
scripts/serve.sh ensure     # brings up Express + Caddy + MCP in a tmux session
```

For boot persistence, install the systemd unit (the provisioning script does this):
a `oneshot` `atlas-kit.service` whose `ExecStart` is `serve.sh ensure`, `ExecStop` is
`serve.sh stop`. `serve.sh` runs each service as a **tmux window** and restarts them
**in place** — it never tears the session down (an outage-hardening invariant covered
by `scripts/serve-tmux.test.sh`). A `*/2 min` watchdog cron re-runs `serve.sh ensure`
so a downed dashboard self-heals within ~2 minutes.

## 7. Claude Code CLI (subscription auth)

```bash
npm i -g @anthropic-ai/claude-code
claude            # then /login — sign in on your subscription (NOT an API key)
```

Leave `ANTHROPIC_API_KEY` **blank** everywhere. `serve.sh` strips it from the service
env and each agent launches with `env -u ANTHROPIC_API_KEY`, so nothing can fall back
to API-key billing. Agents run `claude --dangerously-skip-permissions` (headless) with
`IS_SANDBOX=1`.

Each launched agent also loads one of the MCP configs in `api/src/mcp/` with
`--strict-mcp-config`: `dev.mcp.json` (box-local dev agents — the seven read-only vault
tools), `worker.mcp.json` (the paired Atlas worker — same profile) and
`control.mcp.json` (the Atlas orchestrator chat — plus the agent-control tools). **All
three hard-code `/workspace` as the repo root** — if you cloned elsewhere, edit the
paths in all three (and in the root `.mcp.json`).

## 8. Create your vault + point `VAULT_PATH` at it

Atlas Kit ships no vault. Create yours from the
[llm-atlas template](https://github.com/GregorKoehler/llm-atlas) (private), clone it on
the box, and point at it:

```bash
gh repo create my-atlas --private --template GregorKoehler/llm-atlas
gh repo clone <you>/my-atlas /vault
```

Then set `VAULT_PATH=/vault` in `.env`. The vault needs `Wiki/` and `Tasks/` folders; a
`Wiki/Legend.md` marks it as a **typed** Atlas (unlocks `query_atlas` + the orchestrator
tools). Add `*.md merge=union` to the vault's `.gitattributes` so append-only logs merge
cleanly (the llm-atlas template already does). Set your commit identity via
`ATLAS_AUTHOR_NAME` / `ATLAS_AUTHOR_EMAIL`.

Run agents against the vault by keeping its checkout writable and reachable by the box's
`gh` auth; the box commits back through the serial queue.

Then seed the kit's **own** project card, so the dashboard has a card for Atlas Kit itself
from the first boot:

```bash
node --env-file=.env scripts/seed-self-card.mjs
```

It writes `Wiki/Projects/Atlas-Kit.md` from
[`infra/atlas-kit-card.template.md`](../infra/atlas-kit-card.template.md) — through the
same commit queue as everything else — filling in this checkout's path, your `origin` URL
and the spawn key if one is registered. **Idempotent: it never overwrites an existing
page**, so re-running it after you've rewritten the goal is a no-op. The card carries
`self_deploy: true` + `repo_path:`, which is what gives it a **Redeploy** button
([docs/UPDATING.md](UPDATING.md)).

The spawn allowlist doesn't exist yet at this point, so the card ships without an
`agent_repo:`. Once you add the kit's own checkout to `agent-local-repos.json` (below), add
that key to the page by hand to get dev agents on this card — a re-run won't do it for you.

## 9. Cron jobs

Install [`infra/atlas-kit.cron`](../infra/atlas-kit.cron) (the provisioning script does
this) to `/etc/cron.d/atlas-kit`:

- the **`serve.sh ensure` watchdog** (every 2 min),
- **`refresh-atlas.mjs`** — git-pulls the vault checkout so the Kanban + graph auto-update
  as your phone/agents commit (every 15 min),
- **`clear-done.mjs`** — archives completed tasks off the board into `Tasks/.archive/`
  (daily; kept in git history),
- **`refresh-github.mjs`** — your GitHub contribution counts → the Scorecard's **GitHub**
  group + its one-year sparkline (twice an hour).

The last one is opt-in and needs one line of config — your GitHub login:

```bash
gh api user --jq .login                       # the login gh is authenticated as
echo 'ATLAS_GITHUB_USER=<that-login>' >> .env # then: scripts/serve.sh restart
node --env-file=.env scripts/refresh-github.mjs   # first fill, ~1s
```

Auth is the **`gh` CLI on your own login** — no token in `.env` — which is also why
private-repo contributions are counted. Run `gh auth login` as the user the cron runs as
(root in the reference setup). Leave `ATLAS_GITHUB_USER` blank and the script is a clean
no-op: no GitHub tile on the Scorecard, no error. The files land in `DATA_DIR`
(`<VAULT_PATH>/data` by default).

## 10. (Optional) workstation bridge for remote dev agents

To run dev agents in Docker containers on your workstation instead of on the box:

1. On the workstation (joined to the tailnet), clone this repo and run
   `sudo scripts/install-agent-bridge.sh`. It seeds `agent-bridge/bridge.env`
   (`BRIDGE_TOKEN`, bind the tailnet IP), installs a systemd unit, and needs Node ≥ 18.
   The unit carries `Nice`/`CPUWeight`/`OOMScoreAdjust` so the bridge keeps answering
   when the box saturates — re-run this script (it's idempotent) to upgrade an older
   unit that predates them. Uncomment `BRIDGE_PULL_USER=<your-user>` in `bridge.env`
   if you want the dashboard's "Redeploy bridge" button to work (it runs as root,
   which has no `gh` auth of its own).
2. Map your repos in `agent-bridge/repos.json` (copy from `repos.example.json`) —
   `{ "<key>": { "container": "<docker name>", "path": "<repo path in container>" } }`.
   Each container must have `tmux + git + node + claude + gh` baked into its image.
3. On the **box**, set `AGENT_BRIDGE_URL=http://<workstation-tailnet-ip>:7878` and
   `AGENT_BRIDGE_TOKEN=<the same BRIDGE_TOKEN>` in `.env`, and `serve.sh restart`.

See [`agent-bridge/README.md`](../agent-bridge/README.md) for the full bridge contract
and security checklist.

## Optional addons (after the ten steps)

Anything with a heavier class of dependency than "read markdown off disk" ships as an
**addon** — a self-contained directory under `addons/<name>/`, loaded only when you
enable it. With none enabled the kit is byte-identical to one that never had the
framework, so the install above is complete on its own.

```bash
bash addons/<name>/install.sh            # idempotent; --check reports state
echo 'ATLAS_ADDONS=semantic-search' >> .env   # …or: cp addons.example.json addons.json
scripts/serve.sh restart                 # enabling is a restart, not a reload
curl -s http://127.0.0.1:8080/api/addons # what is actually enabled on this box
```

`ATLAS_ADDONS` wins whenever it is **defined** (empty means *no addons*); `addons.json`
is the gitignored file used when it isn't. Each addon's README states what it needs, what
it costs and the config only you can supply — a cookie file, a feed list:

- **[`semantic-search`](../addons/semantic-search/README.md)** — dense retrieval as a
  second search leg beside the built-in full-text pass.
- **[`instagram-ingest`](../addons/instagram-ingest/README.md)** — one post or reel → a
  `Wiki/Sources/` page, using **your own** cookies (its README is also the guide to
  exporting a browser session safely).
- **[`news-ingest`](../addons/news-ingest/README.md)** — an hourly sweep of **your own**
  RSS/Atom feeds → `Wiki/Sources/` pages plus a rolling digest.

[docs/ADDONS.md](ADDONS.md) is the model, the hook API and the shipped catalog.

---

### Verifying it works

- `curl http://127.0.0.1:8080/api/health` → `{"ok":true,...}`.
- Open `dashboard.<your-domain>` on your phone → you should hit the Access login, then
  the dashboard.
- The home tab shows the **Atlas Kit** card seeded in step 8, with a **Redeploy** button.
- Add a repo to `agent-local-repos.json`, then give a `Wiki/Projects/*.md` page
  `type: project`, a non-empty `goal:` (that pair is what makes it a card) and an
  `agent_repo:` key, and spawn an agent from its project card — its `tmux` transcript
  should stream into the card.

Later, to move this box onto newer kit code: [docs/UPDATING.md](UPDATING.md).
