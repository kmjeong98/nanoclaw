#!/bin/bash
set -e

NODE_PATH=$(which node 2>/dev/null || echo "")
if [ -z "$NODE_PATH" ]; then
  echo "Error: node not found in PATH"
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_DIR="$HOME/.config/systemd/user"
mkdir -p "$SERVICE_DIR"

cat > "$SERVICE_DIR/nanoclaw.service" << EOF
[Unit]
Description=NanoClaw Discord Agent Orchestrator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
EnvironmentFile=$PROJECT_DIR/.env
ExecStart=$NODE_PATH $PROJECT_DIR/dist/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable nanoclaw

echo "Service installed."
echo "  Node: $NODE_PATH"
echo "  Project: $PROJECT_DIR"
echo ""
echo "Run:"
echo "  systemctl --user start nanoclaw"
echo "  loginctl enable-linger \$(whoami)"
