#!/usr/bin/env bash
# ------------------------------------------------------------------ #
# Install the Atlas Kit agent-bridge on the WORKSTATION (host-native).
#
# The bridge holds docker access (≈ root) and is reached by the Hetzner
# box over the Tailscale tailnet. This script:
#   1. checks prerequisites (node, docker, tmux, tailscale)
#   2. seeds repos.json + a bridge bearer token (if absent)
#   3. binds the bridge to the tailnet IP (from `tailscale ip -4`)
#   4. installs + starts a systemd unit (or prints the manual command)
#
# Re-runnable. Run from the cloned repo root on the workstation:
#   sudo scripts/install-agent-bridge.sh
# (sudo only needed to write the systemd unit; omit to just scaffold config.)
# ------------------------------------------------------------------ #
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_DIR="$ROOT/agent-bridge"
ENV_FILE="$BRIDGE_DIR/bridge.env"
SERVICE="atlas-kit-agent-bridge"
PORT="${BRIDGE_PORT:-7878}"

say() { printf '\033[36m[agent-bridge]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[agent-bridge] %s\033[0m\n' "$*" >&2; exit 1; }

# --- 1. prerequisites ---------------------------------------------------------
for bin in docker tmux; do
  command -v "$bin" >/dev/null || die "missing prerequisite: $bin"
done
command -v tailscale >/dev/null || say "WARNING: tailscale not found — install it and bind to the tailnet IP, or the box can't reach the bridge."

# The service runs THIS node (not whatever's on the interactive PATH). On older
# distros the system node is ancient (Ubuntu 20.04 ships v10), which can't parse
# the bridge's ESM — so demand >=18 and let the operator point at a newer one.
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] || die "node not found. Install Node >=18, or re-run with: sudo NODE_BIN=/path/to/node $0"
NODE_MAJOR="$("$NODE_BIN" -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "node at $NODE_BIN is $("$NODE_BIN" --version 2>/dev/null || echo unknown) — the bridge needs >=18.
  Install a modern Node (apt is often broken on old boxes — a standalone tarball avoids it):
    cd /tmp && curl -fsSLO https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.gz
    sudo mkdir -p /opt/node20 && sudo tar -xzf node-v20.18.1-linux-x64.tar.gz -C /opt/node20 --strip-components=1
  then re-run:  sudo NODE_BIN=/opt/node20/bin/node $0"
fi
say "using node $("$NODE_BIN" --version) at $NODE_BIN"

# --- 2. config: repos allowlist + bearer token --------------------------------
if [ ! -f "$BRIDGE_DIR/repos.json" ]; then
  cp "$BRIDGE_DIR/repos.example.json" "$BRIDGE_DIR/repos.json"
  say "seeded agent-bridge/repos.json from the example — EDIT IT (repo → {container, path})."
fi

if [ ! -f "$ENV_FILE" ]; then
  TOKEN="$("$NODE_BIN" -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  TS_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
  HOSTBIND="${TS_IP:-127.0.0.1}"
  {
    echo "# agent-bridge runtime config (generated; keep secret)"
    echo "BRIDGE_TOKEN=$TOKEN"
    echo "BRIDGE_PORT=$PORT"
    echo "# Bound to the tailnet IP so the bridge is NOT on the home LAN."
    echo "BRIDGE_HOST=$HOSTBIND"
    echo "# AGENT_LAUNCH_CMD='IS_SANDBOX=1 claude --dangerously-skip-permissions {task}'"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  say "wrote $ENV_FILE (bridge bearer + bind host)."
  say "  → put the SAME token on the box as AGENT_BRIDGE_TOKEN, and"
  say "    AGENT_BRIDGE_URL=http://$HOSTBIND:$PORT in the dashboard's .env."
  if [ -z "${TS_IP:-}" ]; then
    say "  ⚠ tailscale IP not detected — BRIDGE_HOST is loopback; set it to the tailnet IP before the box can reach it."
  fi
else
  say "$ENV_FILE already exists — leaving it untouched."
fi

# --- 3. systemd unit (or manual fallback) -------------------------------------
# NODE_BIN was resolved + version-checked in section 1.
UNIT="/etc/systemd/system/${SERVICE}.service"
if [ "$(id -u)" -eq 0 ]; then
  cat > "$UNIT" <<EOF
[Unit]
Description=Atlas Kit agent-bridge (drive dev-container Claude Code sessions)
After=network-online.target docker.service tailscaled.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$BRIDGE_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $BRIDGE_DIR/server.mjs
Restart=on-failure
RestartSec=3
# It needs docker access; keep the rest minimal.
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "$SERVICE"
  say "installed + started systemd unit: $SERVICE"
  say "logs: journalctl -u $SERVICE -f"
else
  say "not root — skipped the systemd unit. To run manually:"
  say "  ( set -a; . '$ENV_FILE'; set +a; '$NODE_BIN' '$BRIDGE_DIR/server.mjs' )"
  say "or re-run with sudo to install the service."
fi

say "done. Verify (from the box, over the tailnet):"
say "  curl -s http://\$BRIDGE_HOST:$PORT/health"
