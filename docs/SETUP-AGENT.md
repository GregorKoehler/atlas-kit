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
drive it*: interview first, verify every step, stay safe, offer the optional addons once
the core install is green, summarize at the end.

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
  **Then, once that check passes, seed the kit's own project card:** `node --env-file=.env
  scripts/seed-self-card.mjs`. It writes `Wiki/Projects/Atlas-Kit.md` through the commit
  queue, filling in the repo path, the `origin` URL and the spawn key if one is registered
  — and it **never overwrites an existing page**, so it is safe on a re-run (Safety §1).
  Say what it wrote. Skip it only if the operator says they don't want the card. **Verify:**
  `curl -s http://127.0.0.1:8080/api/projects` lists **Atlas Kit** with `selfDeploy: true`
  and a `repo` path — that pair is what puts the **Redeploy** button on the card
  ([docs/UPDATING.md](UPDATING.md), which is also the answer to "how do I update this box
  later?").
- **Step 9 — cron.** `install -m 644 infra/atlas-kit.cron /etc/cron.d/atlas-kit`.
  **Verify:** the file exists and lists the watchdog + `refresh-atlas.mjs` +
  `clear-done.mjs` + `refresh-github.mjs` lines.
  **Then offer the GitHub Scorecard stat** (optional, one line of config): read the login
  `gh` is already authenticated as with `gh api user --jq .login`, **show it and ask** —
  it goes into a config file and onto their dashboard, so never write it unasked, and take
  a no (the script is a clean no-op while `ATLAS_GITHUB_USER` is blank: no tile, no error).
  On a yes, set `ATLAS_GITHUB_USER=<login>` in `.env`, `scripts/serve.sh restart`, and run
  `node --env-file=.env scripts/refresh-github.mjs` once for the first fill. Auth is their
  own `gh` login — never ask for or write a token. **Verify:** `curl -s
  http://127.0.0.1:8080/api/data/scorecard` includes a `GitHub Contributions (1y)` stat,
  and the Scorecard shows a **GitHub** group. ⚠️ Cron runs as **root**: if `gh auth status`
  fails for root, say so — the cron will no-op until they `gh auth login` there.
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
  the operator has checked out here. If one of them is the kit's own checkout, add that key
  as `agent_repo:` to the `Wiki/Projects/Atlas-Kit.md` seeded in step 8 — the seed ran
  before this allowlist existed and never overwrites, so this one line is manual. Offer a smoke test: add a `Wiki/Projects/*.md` page
  with `type: project`, a non-empty `goal:` (that pair is what makes it a card — without
  it nothing renders) and an `agent_repo:` key, then spawn one agent from its project
  card — its `tmux` transcript should stream into the card. (Ask before spawning; it
  consumes their subscription.)

## Phase 1b — Offer the optional addons (only once the core install verifies)

Core is a whole install on its own. The **addons** are extras with a different class of
dependency — a 1.4 GB encoder, a browser cookie jar, a feed poller on a timer — and with
none enabled the kit is byte-identical to one that never had the framework
([docs/ADDONS.md](ADDONS.md)). So "none" is a finished install, not a partial one: offer
them **after** step 6's health check and step 8's vault check have passed, never during
Phase 1, and take a no for an answer.

Read [docs/ADDONS.md](ADDONS.md) and the three `addons/*/README.md` files before you
offer anything. Then present all three in **one** message — what each does **and** what
it costs, taken from that README's **"What it costs"** table:

- **[`semantic-search`](../addons/semantic-search/README.md)** — a second, dense retrieval
  leg beside core's full-text pass (it finds the page when you don't know the words that
  page uses). **Costs:** ~1.4 GB of disk out of tree, ~660 MB resident while warm, ~35 MB
  of vectors per ~11k chunks, and a first full index measured at ~82 min on a 1.6k-page
  vault.
- **[`instagram-ingest`](../addons/instagram-ingest/README.md)** — one Instagram post or
  reel → a `Wiki/Sources/` page (caption verbatim, stills, a `claude -p` read). **Costs:**
  `yt-dlp` (~30 MB out of tree), **their own** Instagram cookies, and stills committed
  into the vault's git history permanently. Nothing runs unless it is called.
- **[`news-ingest`](../addons/news-ingest/README.md)** — an hourly RSS/Atom sweep; every
  unseen item → a `Wiki/Sources/` page plus a rolling digest. **Costs:** the one addon
  that spends on a timer — one `claude -p` call per NEW item on their subscription, capped
  at 12 per sweep, so ≤ 288 short calls/day at the defaults, plus one permanent markdown
  page per item.

⚠️ **State the cost before enabling, every time, and do not round it down.** The operator
is deciding whether to spend their disk, RAM and subscription calls; the honest table is
in each README and quoting it is the point. If they decline one, name the one-liner that
enables it later and move on — Phase 3 records it as skipped.

For each addon they say yes to, five moves in this order:

1. **Install its dependencies.** `bash addons/<name>/install.sh` — idempotent, and
   `--check` reports state without installing (`0` installed · `2` installable · `1`
   cannot). ⚠️ `semantic-search`'s is a ~1.4 GB download and `news-ingest`'s writes
   `/etc/cron.d/atlas-kit-addons` as root — both are Safety §2 "ask first" actions. Run
   non-root and the cron step is skipped with the `sudo node scripts/addon-cron.mjs
   --install` line to run instead.
2. **Enable it.** Either `ATLAS_ADDONS=<name>[,<name>]` in `.env` — it **wins whenever
   defined**, and `ATLAS_ADDONS=` (empty) means *no addons*, not "read the file" — or
   `cp addons.example.json addons.json` and list them in its `enabled` array (gitignored,
   used only when `ATLAS_ADDONS` is unset). Pick one mechanism; don't set both.
3. **The per-addon config you cannot do for them** — see below.
4. **`scripts/serve.sh restart`.** Enabling is a restart, not a reload.
5. **Verify:** `curl -s http://127.0.0.1:8080/api/addons` lists the addon with its hooks
   and its `status`, and `errors` is empty. An addon that failed to load is *recorded
   there and skipped* — the API comes up regardless, so a working dashboard is no
   evidence that the addon loaded.

- **`semantic-search` — the index has to be built.** Until it is, the leg answers
  `available: false` with a reason and the full-text leg is unchanged: inert, not broken.
  Build it with `node addons/semantic-search/scripts/index.mjs`; say the measured ~90 min
  cold first pass out loud before you start it, and run it in the background. `install.sh`
  wires the five-minute sweep when run as root. **Verify:** `GET /api/addons` shows its
  status, and after a sweep the dashboard scorecard grows a **Semantic index** group.
- **`instagram-ingest` — the cookie jar is theirs, and only theirs.** ⚠️ **You never
  handle it.** Do not export it, read it, open it, copy it, print it, or put any part of
  it in a file, a prompt or the chat: a cookie jar is a **live login session** — anyone
  holding it can act as them on Instagram without a password and without 2FA. Hand them
  §2 *"Your own cookies"* of the addon's README and let them do it themselves — Option A,
  export a Netscape `cookies.txt` and keep it **outside the repo tree** (`~/.atlas-kit/`,
  `chmod 600`); or Option B, `ATLAS_IG_COOKIES_BROWSER=firefox` when this box is the
  machine they browse on. Your part is one line of `.env`: the *path* in
  `ATLAS_IG_COOKIES_FILE` or the browser in `ATLAS_IG_COOKIES_BROWSER` (if both are set,
  the file wins). Never relocate the jar into the repo, and never commit it (Safety §3).
  **Verify:** `GET /api/addons` reports whether `yt-dlp` resolved and which cookie mode is
  configured. A test ingest is optional and needs a yes — it writes a vault page plus
  permanent image blobs and spends a subscription call.
- **`news-ingest` — the feed list is theirs to write.** `install.sh` seeds
  `addons/news-ingest/feeds.json` (gitignored) from an example carrying one neutral
  placeholder, and never touches it again. **Do not pick feeds for them:** ask for the
  URLs and write exactly those — `{url, tag?, title?}` entries or bare URL strings,
  `http(s)` only. A bad entry is dropped, not fatal, and comes back in `errors[]`. Feed
  edits take effect on the next sweep — no restart; only enabling the addon is a restart.
  Say the timer cost plainly and offer to lower `ATLAS_NEWS_MAX_ITEMS` *before* they add
  many feeds, not after. **Verify:** `/etc/cron.d/atlas-kit-addons` carries the hourly
  sweep line (that file is regenerated from the enabled addons, never hand-edited), and
  `GET /api/addons` reports the feed list and the last run; the manual-sweep and CLI forms
  are in §4 of the README.

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
- **Which addons are enabled**, if any — what each now costs on this box, and what still
  needs the operator (a cookie file that expires, a feed list to grow).
- **How to update this box later** — the **Redeploy** button on the Atlas Kit card is the
  one-click path; [docs/UPDATING.md](UPDATING.md) has it and the manual one.
- **What was skipped** and why (no domain ⇒ no Cloudflare; no bridge; addons declined;
  etc.), and the one-liner to enable each later.
