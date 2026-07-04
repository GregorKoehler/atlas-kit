# Atlas Kit — setup (zero to running)

This is the exact path from a fresh box to a live, phone-reachable dashboard that can
spawn Claude Code agents. Most of steps 1–9 are automated by
[`scripts/provision-hetzner.sh`](../scripts/provision-hetzner.sh); the human-only bits
(Cloudflare Access, Tailscale) are called out. Local dev is simpler — see the
[Quick start](../README.md#quick-start-local-dev) in the README.

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
     defense-in-depth (a no-op until both are set).

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

## 9. Cron jobs

Install [`infra/atlas-kit.cron`](../infra/atlas-kit.cron) (the provisioning script does
this) to `/etc/cron.d/atlas-kit`:

- the **`serve.sh ensure` watchdog** (every 2 min),
- **`refresh-atlas.mjs`** — git-pulls the vault checkout so the Kanban + graph auto-update
  as your phone/agents commit (every 15 min),
- **`clear-done.mjs`** — archives completed tasks off the board into `Tasks/.archive/`
  (daily; kept in git history).

## 10. (Optional) workstation bridge for remote dev agents

To run dev agents in Docker containers on your workstation instead of on the box:

1. On the workstation (joined to the tailnet), clone this repo and run
   `sudo scripts/install-agent-bridge.sh`. It seeds `agent-bridge/bridge.env`
   (`BRIDGE_TOKEN`, bind the tailnet IP), installs a systemd unit, and needs Node ≥ 18.
2. Map your repos in `agent-bridge/repos.json` (copy from `repos.example.json`) —
   `{ "<key>": { "container": "<docker name>", "path": "<repo path in container>" } }`.
   Each container must have `tmux + git + node + claude + gh` baked into its image.
3. On the **box**, set `AGENT_BRIDGE_URL=http://<workstation-tailnet-ip>:7878` and
   `AGENT_BRIDGE_TOKEN=<the same BRIDGE_TOKEN>` in `.env`, and `serve.sh restart`.

See [`agent-bridge/README.md`](../agent-bridge/README.md) for the full bridge contract
and security checklist.

---

### Verifying it works

- `curl http://127.0.0.1:8080/api/health` → `{"ok":true,...}`.
- Open `dashboard.<your-domain>` on your phone → you should hit the Access login, then
  the dashboard.
- Add a repo to `agent-local-repos.json`, give a `Wiki/Projects/*.md` page an
  `agent_repo:` key, and spawn an agent from its project card — its `tmux` transcript
  should stream into the card.
