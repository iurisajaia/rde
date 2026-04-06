#!/usr/bin/env bash
# Supervisord entry: resolve Node via nvm (works for ~/.nvm or /usr/local/nvm).
set -e
cd /opt/fundbox/rde-ui
export HOME="${HOME:-/home/ubuntu}"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
set +u
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
elif [ -s /usr/local/nvm/nvm.sh ]; then
  NVM_DIR=/usr/local/nvm
  export NVM_DIR
  # shellcheck source=/dev/null
  . /usr/local/nvm/nvm.sh
else
  echo "[rde-ui] nvm not found; install nvm and Node 20+" >&2
  exit 1
fi
if [ -f .nvmrc ]; then
  nvm use
else
  nvm use 20
fi
exec node server.js
