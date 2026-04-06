#!/usr/bin/env bash
# Run on the RDE after the repo exists at REPO_DIR (git pull, rsync, CI artifact, etc.).
# Does not depend on rde sync.
set -euo pipefail

REPO_DIR="/opt/fundbox/rde-ui"
NODE="/usr/local/nvm/versions/node/v16.20.2/bin/node"
NPM="/usr/local/nvm/versions/node/v16.20.2/bin/npm"
CONF_SRC="${REPO_DIR}/deployment/rde/rde-ui.ini"
SUPERVISOR_CONF="/etc/supervisor/conf.d/rde-ui.ini"
NGINX_CONF="/etc/nginx/sites-enabled/rde-ui.conf"
LOG_DIR="/opt/fundbox/logs"

echo "=== rde-ui setup ==="

mkdir -p "$LOG_DIR"

echo "Installing npm dependencies..."
cd "$REPO_DIR"
$NPM install --ignore-scripts

echo "Building frontend..."
$NPM run build:web

echo "Installing supervisord config..."
sudo cp "$CONF_SRC" "$SUPERVISOR_CONF"
sudo chmod 644 "$SUPERVISOR_CONF"

echo "Installing nginx config..."
sudo cp "${REPO_DIR}/deployment/rde/nginx-rde-ui.conf" "$NGINX_CONF"
sudo nginx -t && sudo nginx -s reload

echo "Reloading supervisord..."
sudo supervisorctl reread
sudo supervisorctl update
sudo supervisorctl restart rde-ui 2>/dev/null || sudo supervisorctl start rde-ui

echo ""
echo "=== Done! ==="
echo "rde-ui API:  https://bchkhaidze-fbx-rde.fbx.im:20000/ (Swagger: .../api/docs)"
echo "rde-ui UI:   https://bchkhaidze-fbx-rde.fbx.im:20001/rde-ui/"
echo "Status:  sudo supervisorctl status rde-ui"
echo "Logs:    tail -f ${LOG_DIR}/rde-ui.log"
