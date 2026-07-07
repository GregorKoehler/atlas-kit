---
name: update-config
description: Configure Atlas Kit itself — .env, the spawnable-repo allowlist, the MCP wiring, and the infra templates. Use for "add a repo to spawn", "change the vault path", "turn on Cloudflare Access", "add a cron job", "wire up the workstation bridge" — anything about this repo's own runtime config, not the vault's content.
---

# Atlas Kit config

This repo's config surface, what each piece governs, and how to change it safely.

1. **`.env`** (gitignored; copy from `.env.example`) — the source of truth for runtime config:
   - `VAULT_PATH` (required) — absolute path to the Atlas vault checkout. Changing it means
     re-pointing the dashboard at a different vault; verify with
     `curl http://127.0.0.1:$API_PORT/api/wiki/pages` after restart.
   - `DASHBOARD_BEARER_TOKEN` (required) — the app-layer bearer for every write/exec route.
     Regenerate with `openssl rand -hex 32`; never print or commit the real value.
   - `API_PORT`/`API_HOST`, `MCP_PORT`/`MCP_BIND` — service bind addresses; both default to
     `127.0.0.1`-only, fronted by Caddy in production. Don't widen the bind without also
     tightening Caddy/Access — see step 3.
   - `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` — Cloudflare Access gate for the *remote* MCP
     connector. Leave both blank for local-only use (JWT check becomes a no-op). Filling
     them in requires the Access application to already exist (`docs/SETUP.md`).
   - `WORKSPACE_DIR`, `AGENT_LOCAL_DIR`, `AGENT_LOCAL_MAX_CONCURRENT`, `AGENT_TITLE_MODEL` —
     box-local dev/knowledge-agent runtime (worktree root, state dir, concurrency cap, the
     small model used to title a new agent session).
   - `ATLAS_AUTHOR_NAME`/`ATLAS_AUTHOR_EMAIL`/`ATLAS_BRANCH` — the git identity and branch
     the API commits to the vault as.
   - `AGENT_BRIDGE_URL`/`AGENT_BRIDGE_TOKEN`/`AGENT_WORKSTATION_LABEL`/`AGENT_BRIDGE_REPOS` —
     the optional remote workstation bridge; leave `AGENT_BRIDGE_URL` blank to disable.
   Restart the API (`serve.sh restart` or your process manager) after any `.env` change —
   it's read at boot, not hot-reloaded.

2. **`api/src/agent-local-repos.json`** (gitignored, box-local — NOT the same as `.env`) —
   the allowlist of repos `spawn_agent` may target: `{"<key>": {"path": "/abs/path"}}`.
   Adding a repo here is what makes it show up in `list_agents`' `localRepos`. No restart
   needed if the API re-reads it per call — check `localRepoKeys()` in `agent-local.mjs`;
   restart if unsure. Never add a path outside repos you actually want agents writing to.

3. **`.mcp.json` / `api/src/mcp/control.mcp.json`** — how a `claude` session connects to
   this repo's MCP server (`query_vault`/`query_atlas`/wiki reads always; the
   `list_agents`/`spawn_agent`/… control tools only under `control.mcp.json`, gated by
   `ATLAS_AGENT_CONTROL=1`). Both hardcode `/workspace` as the repo path — update both if
   you clone Atlas Kit somewhere else, and keep the control tools off any config an
   ordinary vault-chat session loads (that's what keeps a knowledge agent from
   accidentally getting spawn/kill powers over other agents).

4. **`infra/`** — deployment templates, not live config: `Caddyfile.example` (reverse proxy
   + optional Access), `cloudflared-config.example.yml` (tunnel), `atlas-kit.cron` (the
   done-column archive job via `scripts/clear-done.mjs`). Copy to the real filename outside
   git (or keep as root-owned files under `/etc/...`) — never commit a filled-in version of
   an `.example` file; secrets belong in `.env` or the tunnel's own credentials file, never
   inline in a Caddyfile you might commit.

5. **After any change**: confirm the specific thing you touched actually took effect (env
   var → restart + `curl` the affected endpoint; repo allowlist → `list_agents` shows the
   new key; Caddy/cloudflared → hit the public URL) rather than assuming a config edit was
   enough on its own.
