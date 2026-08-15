# Atlas Kit — agent-guided setup

> **For humans (the 5-line bootstrap).** On a fresh Ubuntu 24.04 box, as root:
>
> ```bash
> apt update && apt -y install git curl
> curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt -y install nodejs gh
> npm i -g @anthropic-ai/claude-code && claude       # → /login (your Claude subscription)
> gh auth login                                       # pick HTTPS
> gh repo clone <your-user>/atlas-kit /workspace && cd /workspace && claude
> ```
>
> Then in that `claude` session, say: **"Read docs/SETUP-AGENT.md and set me up."**
> The agent takes it from there. Prefer to do it by hand? Use
> [docs/SETUP.md](SETUP.md) instead — this file is the same 10 steps, driven for you.

---

Everything below is addressed **to the setup agent**, not the human.

## Your job

Drive a full Atlas Kit install on this box by executing **[docs/SETUP.md](SETUP.md)
steps 2–10** in order, adapted to the operator's answers. You are running as a
`claude` session inside the repo (assume `/workspace` unless the operator says
otherwise). SETUP.md is the source of truth for the *what*; this file is the *how you
drive it*: interview first, verify every step, stay safe, summarize at the end.

Read [docs/SETUP.md](SETUP.md) now, in full, before you touch anything.

## Phase 0 — Interview first, then act

Ask the operator these up front, in one message, and wait for answers. Do **not** start
installing until you have them. Restate the plan back before you begin.

1. **Operator display name** — shown in the dashboard hero (sets `VITE_OPERATOR_NAME`).
2. **Domain** — a domain you control for the public dashboard, **or** "none —
   Tailscale/localhost only". No domain ⇒ skip Cloudflare entirely (step 4); the
   dashboard is reached over Tailscale or an SSH port-forward instead.
3. **Cloudflare account** — yes/no. Needed only for a public domain + edge auth (step 4).
4. **Tailscale** — yes/no. Needed for the optional remote workstation bridge, and a
   handy way to reach a domain-less box (step 3).
5. **Remote workstation bridge** — yes/no. Do you want dev agents to run in Docker
   containers on another machine (step 10)? If no, agents run box-local only.
6. **Vault** — one of:
   - **Create a new one** from the template:
     `gh repo create <name> --private --template GregorKoehler/llm-atlas`, then clone it; or
   - **Existing vault repo** — give the `owner/name` (or a path already on the box). It
     must have `Wiki/` + `Tasks/`; a `Wiki/Legend.md` marks it as a typed Atlas.
7. **On-disk locations** — where the repo lives (default `/workspace`) and where the
   vault should be cloned (default `/vault`, which `VAULT_PATH` defaults to).

Fold the answers into a short written plan (which steps run, which are skipped) and
confirm it before Phase 1.

## Phase 1 — Execute SETUP.md steps 2–10, verifying after each

Run each step, then run its **verification checkpoint**. **Never proceed past a failing
check** — stop, diagnose, tell the operator, fix, re-verify. Skip a step only when the
interview says so (e.g. no domain ⇒ skip step 4; no bridge ⇒ skip step 10), and say so.

The checks below are SETUP.md's "Verifying it works" list, distributed per step.

- **Step 2 — base hardening + user.** Set up the sudo user / SSH keys / firewall.
  ⚠️ Editing `/etc/ssh/sshd_config` can lock the operator out — see Safety §4: show the
  diff, get a yes, and **do not** restart sshd until they've confirmed a second working
  session. **Verify:** `sshd -t` exits clean; `ufw status` shows OpenSSH allowed.
- **Step 3 — Tailscale** (only if chosen). `tailscale up`. **Verify:** `tailscale status`
  shows this node `active`; record `tailscale ip -4` (you'll need it for the bridge and
  for reaching a domain-less box).
- **Step 4 — Cloudflare Tunnel + Access** (only with a domain). ⚠️ Creating a tunnel and
  DNS routes are external/account actions — **ask before each** (Safety §2). Write
  `/root/.cloudflared/config.yml` from `infra/cloudflared-config.example.yml`. The Access
  apps + Managed-OAuth AUD/team-domain are a human/browser step in the Cloudflare
  dashboard — hand the operator the exact values to enter, then have them paste back the
  AUD tag + team domain for `.env`. ⚠️ Both values are load-bearing: once the tunnel
  routes `mcp.<domain>`, the MCP server refuses to start with either blank — check its
  log for `Access JWT check: ENFORCED` rather than `REFUSING TO START`.
  **Verify:** `cloudflared tunnel list` shows the tunnel; `dashboard.<domain>` resolves and hits the Access login. (No domain ⇒ skip;
  note that the dashboard is reached via the tailnet IP or `ssh -L 8080:127.0.0.1:8080`.)
- **Step 5 — Caddy.** `cp infra/Caddyfile.example infra/Caddyfile` and replace
  `<REPO_ROOT>` with the repo path. **Verify:** `caddy validate --config infra/Caddyfile`
  passes.
- **Step 6 — Node + the services.** Write `.env` first (see Safety §3):
  `cp .env.example .env`; set `DASHBOARD_BEARER_TOKEN=$(openssl rand -hex 32)`,
  `VAULT_PATH`, `ATLAS_AUTHOR_NAME`/`ATLAS_AUTHOR_EMAIL`, `VITE_OPERATOR_NAME`, and
  `CF_ACCESS_*` if step 4 ran. Then `cd web && npm ci && npm run build` (build **after**
  `VITE_OPERATOR_NAME` is set — it's baked in), `cd ../api && npm ci`, install the systemd
  unit (see SETUP.md step 6 / `scripts/provision-hetzner.sh`), and `scripts/serve.sh
  ensure`. **Verify (the core check):** `curl -fsS http://127.0.0.1:8080/api/health` →
  `{"ok":true,...}`, and `systemctl is-enabled atlas-kit.service` → `enabled`.
- **Step 7 — Claude Code CLI (subscription auth).** Already logged in from the bootstrap.
  **Verify:** `claude --version` works and `grep -c '^ANTHROPIC_API_KEY=$' .env` confirms
  the key is left blank (subscription-only — never set it).
- **Step 8 — vault + `VAULT_PATH`.** Create-from-template or clone the existing vault to
  the chosen path; confirm it has `Wiki/` + `Tasks/`. **Verify:** `curl -s
  http://127.0.0.1:8080/api/wiki/pages` returns the vault's pages (not an empty list on a
  populated vault) and `curl -s http://127.0.0.1:8080/api/tasks` returns its tasks.
- **Step 9 — cron.** `install -m 644 infra/atlas-kit.cron /etc/cron.d/atlas-kit`.
  **Verify:** the file exists and lists the watchdog + `refresh-atlas.mjs` +
  `clear-done.mjs` lines.
- **Step 10 — workstation bridge** (only if chosen). Guide the operator through
  `scripts/install-agent-bridge.sh` on the **workstation** (it's a separate machine —
  you can't run it from here), then set `AGENT_BRIDGE_URL` (the workstation tailnet IP)
  + `AGENT_BRIDGE_TOKEN` in `.env` and `scripts/serve.sh restart`. **Verify:** `curl -s
  http://127.0.0.1:8080/api/agents` shows the bridge with `reachable: true` **and**
  `capacity.known: true` — `known: false` means that bridge predates spawn-capacity
  reporting and nothing is limiting agents on it; have the operator re-run
  `sudo scripts/restart-agent-bridge.sh` there. While you're in `bridge.env`, set
  `BRIDGE_PULL_USER=<their-user>` so the dashboard's "Redeploy bridge" button works.
- **Final — spawn readiness.** To make box-local dev agents spawnable, `cp
  api/src/agent-local-repos.example.json api/src/agent-local-repos.json` and add a repo
  the operator has checked out here. Offer a smoke test: add a `Wiki/Projects/*.md` page
  with `type: project`, a non-empty `goal:` (that pair is what makes it a card — without
  it nothing renders) and an `agent_repo:` key, then spawn one agent from its project
  card — its `tmux` transcript should stream into the card. (Ask before spawning; it
  consumes their subscription.)

## Phase 2 — Safety rules (apply throughout)

1. **Idempotent.** Assume this may be a re-run after a partial install. Detect what's
   already done and skip it: check for an existing `.env`, `infra/Caddyfile`, a running
   `atlas-kit.service`, an existing tunnel, a cloned vault, `/etc/cron.d/atlas-kit`, etc.,
   before creating them. Never clobber an existing `.env` or vault without asking.
2. **Ask before anything paid, external, or account-changing** — creating a Cloudflare
   tunnel, adding DNS routes, `gh repo create`, anything that spends money or touches an
   account the operator owns. State exactly what you're about to do and wait for a yes.
3. **Never put secrets in the repo.** Write `.env` from `.env.example`; generated tokens
   (`DASHBOARD_BEARER_TOKEN`, `AGENT_BRIDGE_TOKEN`, `bridge.env`) live only in
   gitignored files. Never commit `.env`, `*.json` operator-local configs, or credentials.
   Do not print full secrets back into the chat — reference them by name.
4. **Destructive changes need a preview + a yes.** For anything hard to reverse
   (`/etc/ssh/sshd_config`, firewall rules, deleting/overwriting a checkout), show the
   exact diff/command first, get explicit confirmation, and for sshd changes make sure the
   operator has a second working session open before you restart the daemon.

## Phase 3 — Finish with a summary

When every chosen step's check has passed, report:

- **What's running** — the systemd units (`atlas-kit.service`, `cloudflared` if used) and
  the cron jobs, plus the health check result.
- **URLs** — the dashboard URL (`https://dashboard.<domain>` behind Access, or the
  tailnet/`localhost:8080` path for a domain-less box) and the MCP connector host.
- **Where the vault lives** — its path + repo, and that the box commits back to it.
- **How to open the dashboard** and **how to spawn a first agent** (add the repo key to
  `agent-local-repos.json`, give a project page an `agent_repo:`, click Spawn).
- **What was skipped** and why (no domain ⇒ no Cloudflare; no bridge; etc.), and the
  one-liner to enable each later.
