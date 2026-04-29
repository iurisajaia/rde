#!/usr/bin/env bash
# Run on the RDE after the repo exists at REPO_DIR.
set -euo pipefail

REPO_DIR="/opt/fundbox/rde-ui"
CONF_SRC="${REPO_DIR}/deployment/rde/rde-ui.ini"
SUPERVISOR_CONF="/etc/supervisor/conf.d/rde-ui.ini"
FUNDBOX_CONF="/etc/nginx/sites-enabled/fundbox.conf"
LOG_DIR="/opt/fundbox/logs"
NODE_VERSION_DEFAULT="${NODE_VERSION_DEFAULT:-20}"

load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  set +u
  if [ -s /usr/local/nvm/nvm.sh ]; then
    NVM_DIR=/usr/local/nvm
    export NVM_DIR
    # shellcheck source=/dev/null
    . /usr/local/nvm/nvm.sh
  elif [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
  else
    set -u
    echo "nvm not found; install Node 18+ and ensure nvm.sh exists." >&2
    exit 1
  fi
  cd "$REPO_DIR"
  if [ -f .nvmrc ]; then
    nvm install
    nvm use
  else
    echo "No .nvmrc; using Node ${NODE_VERSION_DEFAULT}." >&2
    nvm install "$NODE_VERSION_DEFAULT"
    nvm use "$NODE_VERSION_DEFAULT"
  fi
  set -u
}

echo "=== rde-ui setup ==="

mkdir -p "$LOG_DIR"

load_nvm
echo "Using Node $(node -v) / npm $(npm -v)"

echo "Installing npm dependencies..."
npm install --ignore-scripts

echo "Building frontend..."
npm run build:web

# ─── Patch /rde-ui/ and /rde-api/ into fundbox.conf before location / ────────
if ! grep -q 'location /rde-ui/' "$FUNDBOX_CONF"; then
  echo "Patching $FUNDBOX_CONF to add /rde-ui/ and /rde-api/ locations..."
  sudo python3 - <<'PYEOF'
import sys
path = "/etc/nginx/sites-enabled/fundbox.conf"
with open(path) as f:
    content = f.read()

insert = """    location /rde-api/logs/stream {
        proxy_pass http://127.0.0.1:28000/api/logs/stream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600;
        proxy_connect_timeout 10;
    }

    location /rde-api/ {
        proxy_pass http://127.0.0.1:28000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_connect_timeout 10;
        proxy_read_timeout 60;
    }

    location /rde-ui/ {
        alias /opt/fundbox/rde-ui/dist/;
        index index.html;
        try_files $uri $uri/ /rde-ui/index.html;
    }

"""

if "location /rde-ui/" not in content:
    content = content.replace("    location / {", insert + "    location / {", 1)
    with open(path, "w") as f:
        f.write(content)
    print("patched ok")
else:
    print("already patched")
PYEOF
else
  echo "/rde-ui/ already present in $FUNDBOX_CONF"
fi

# Remove the old standalone rde-ui.conf (8887 port block — no longer needed)
sudo rm -f /etc/nginx/sites-enabled/rde-ui.conf

sudo nginx -t && sudo nginx -s reload

# ─── Supervisor for the Node bridge ──────────────────────────────────────────
echo "Installing supervisord config..."
sudo cp "$CONF_SRC" "$SUPERVISOR_CONF"
sudo chmod 644 "$SUPERVISOR_CONF"
sudo chmod 755 "${REPO_DIR}/deployment/rde/run-rde-ui.sh"

sudo supervisorctl reread
sudo supervisorctl update
sudo supervisorctl restart rde-ui 2>/dev/null || sudo supervisorctl start rde-ui

echo ""
echo "=== Done! ==="
echo "UI:  https://bchkhaidze-fbx-rde.fbx.im/rde-ui/"
echo "API: https://bchkhaidze-fbx-rde.fbx.im/rde-api/supervisor/status"
echo "Logs: tail -f ${LOG_DIR}/rde-ui.log"
