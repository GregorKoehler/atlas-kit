#!/usr/bin/env bash
# provision-hetzner.sh — stand up Atlas Kit on a fresh Hetzner Cloud box
# (Ubuntu 24.04, run as root). Native install — NOT Docker: on a box you own the
# disk is persistent, so serve.sh runs the stack directly under systemd.
#
# Layout (chosen to need ZERO path edits):
#   repo  -> /workspace   (Caddyfile serves root * /workspace/web/dist)
#   vault -> /vault       (VAULT_PATH defaults to /vault)
#
# This is a GUIDED installer: it does the deterministic apt/install/clone work
# and pauses at the steps that need a human (marked [YOU]):
#   1. gh auth login        (so it can clone your private vault + push)
#   2. fill /workspace/.env (set DASHBOARD_BEARER_TOKEN)
#   3. claude /login        (subscription auth, not an API key)
#
# Set REPO_URL + VAULT_URL below (or pass them as env vars), then get this onto
# the box and run: chmod +x provision-hetzner.sh && ./provision-hetzner.sh
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root on the fresh box"; exit 1; }

# EDIT THESE — your Atlas Kit fork and your private Atlas vault (created from the
# llm-atlas template: https://github.com/GregorKoehler/llm-atlas).
REPO_URL="${REPO_URL:-<your-github-user>/atlas-kit}"
VAULT_URL="${VAULT_URL:-<your-github-user>/my-atlas}"

pause() { echo; echo ">>> [YOU] $*"; read -rp ">>> press enter once done… " _; echo; }

echo "== 1. system base =="
apt update && apt -y upgrade
apt -y install git tmux curl ca-certificates gnupg

echo "== 2. node 22 (NodeSource) =="
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt -y install nodejs
node -v

echo "== 3. caddy (binary only — serve.sh runs its OWN caddy on :8080) =="
apt -y install debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt -y install caddy
# kill apt's systemd caddy (it grabs :80/:443); we only want the binary.
systemctl disable --now caddy || true

echo "== 4. cloudflared =="
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
  | tee /etc/apt/sources.list.d/cloudflared.list
apt update && apt -y install cloudflared

echo "== 5. claude CLI + gh =="
npm i -g @anthropic-ai/claude-code
claude --version
apt -y install gh

pause "run 'gh auth login' (pick HTTPS so vault push/pull works too), then come back"

echo "== 6. clone repo + vault =="
[ -e /workspace ] || gh repo clone "$REPO_URL" /workspace
[ -e /vault ]     || gh repo clone "$VAULT_URL" /vault

echo "== 7. config: .env + Caddyfile =="
[ -f /workspace/.env ] || cp /workspace/.env.example /workspace/.env
[ -f /workspace/infra/Caddyfile ] || cp /workspace/infra/Caddyfile.example /workspace/infra/Caddyfile
pause "edit /workspace/.env — set DASHBOARD_BEARER_TOKEN (required; openssl rand -hex 32).
       VAULT_PATH defaults to /vault. CF_ACCESS_* stay blank until the Access app exists."

echo "== 8. build + deps =="
( cd /workspace/web && npm ci && npm run build )
( cd /workspace/api && npm ci )

pause "run 'claude' once and /login (subscription auth), then exit"

echo "== 9. boot persistence (systemd) =="
cat > /etc/systemd/system/atlas-kit.service <<'EOF'
[Unit]
Description=Atlas Kit dashboard (Express API + Caddy + MCP via serve.sh)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/workspace/scripts/serve.sh ensure
ExecStop=/workspace/scripts/serve.sh stop
WorkingDirectory=/workspace

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now atlas-kit.service

# Cron: the self-heal watchdog + vault refresh + daily done-clear.
install -m 644 /workspace/infra/atlas-kit.cron /etc/cron.d/atlas-kit

echo "== 10. local health =="
curl -fsS http://127.0.0.1:8080/api/health && echo "  <- local OK"

cat <<'EOF'

Done. Next (manual, reversible) — see docs/SETUP.md:
  cloudflared tunnel --url http://localhost:8080
    -> opens a random https://<id>.trycloudflare.com — open it on your phone to
       prove the box serves end-to-end. No DNS change, no Cloudflare account.
    Then: DNS cutover on Cloudflare -> Access apps (dashboard + mcp) -> a named
    tunnel from infra/cloudflared-config.example.yml.
EOF
