# Atlas Kit

A self-hosted runtime that drives an **Atlas** knowledge vault (an agent-maintained,
typed markdown wiki — the [llm-atlas](https://github.com/GregorKoehler/llm-atlas)
template) with Claude Code agents: a glass-HUD dashboard, dev + knowledge agents in
tmux, and a task Kanban wired to the vault. See [README.md](README.md) for the full tour.

## Setting up a fresh install

**If the operator asks you to set up / install / provision this box** (e.g. "set me up",
"install Atlas Kit"), read **[docs/SETUP-AGENT.md](docs/SETUP-AGENT.md)** and follow it —
it is written as instructions to you: interview the operator, run the ten setup steps,
verify each one, and stay safe (idempotent; ask before anything paid/external/destructive;
never put secrets in the repo). [docs/SETUP.md](docs/SETUP.md) is the manual version of
the same steps.

## Layout

```
web/      Vite + Preact + TS dashboard (one file per card in src/components/cards/)
api/      Express API: the agent runtime (agent-local.mjs), routes, the MCP server,
          the serial vault commit queue, the typed query engine
addons/   OPTIONAL, env-gated features (see docs/ADDONS.md). Core must run
          byte-identical with zero addons enabled.
scripts/  serve.sh (tmux service manager), refresh-atlas, clear-done, seed-self-card,
          refresh-github, provisioning
infra/    Caddyfile.example, cloudflared-config.example.yml, atlas-kit.cron
agent-bridge/  optional host-native bridge to run agents in remote dev containers
```

## Working on the code

- **Touching the agent runtime (queue/prompt/interrupt/kill/cleanup, the ship marker,
  or the BRIEF/INGEST flow)?** Read **[docs/PROTOCOLS.md](docs/PROTOCOLS.md)** first —
  it maps each protocol to exactly where it's implemented.
- **Writing or changing an addon, or a core seam an addon plugs into?** Read
  **[docs/ADDONS.md](docs/ADDONS.md)** — the hook API, and the invariant that a kit
  with zero addons enabled must answer byte-identically to one without the framework.
- **Touching how an install updates itself** (the Redeploy button, `deploy-routes.mjs`,
  `seed-self-card.mjs`)? Read **[docs/UPDATING.md](docs/UPDATING.md)** — it is the
  operator-facing contract those two implement.
- **Build/verify:** `cd web && npm run build` (Vite; `npm run typecheck` for tsc).
  `cd api && node --env-file=../.env src/server.mjs` runs the API. `npm run dev`
  (root, via `scripts/dev.sh`) runs both for local dev.
- **The vault is a separate repo** — the dashboard reads `Wiki/` + `Tasks/` from
  `VAULT_PATH` and commits back through the serial queue (`atlas-commit-queue.mjs`).
  Never bundle a vault into this repo. ⚠️ `*.md merge=union` means a merge can DOUBLE a
  frontmatter key, which silently untypes the page and deletes its card — no writer can
  prevent it, so the queue self-heals after every pull/merge and the shared reader
  survives the window (`api/src/frontmatter-heal.mjs`, [docs/PROTOCOLS.md](docs/PROTOCOLS.md) §5a).
- **LLM calls use the `claude` CLI on the subscription**, never an API key — leave
  `ANTHROPIC_API_KEY` blank.
- **This is a public repo.** Keep it free of personal data: no real names, emails,
  domains, IPs, tokens, or private repo names — use `.env` (gitignored) + `*.example`
  placeholders. Secrets never get committed.
