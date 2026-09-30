#!/usr/bin/env bash
# Copy this checkout to the VPS, install, build and restart the dashboard. Agents keep running: they live in
# after-office-agents.service, which this doesn't touch.
#   deploy/sync.sh office@VPS [/opt/after-office]
set -euo pipefail

HOST=${1:?usage: deploy/sync.sh user@host [app dir]}
DIR=${2:-/opt/after-office}
cd "$(dirname "$0")/.."

# server secrets (.env) and data (SQLite) live only on the VPS: never overwrite or delete them
# --chmod: the checkout is for the dashboard user only (agents run as another user and must not read it)
rsync -az --delete --chmod=D750,F640 \
  --exclude node_modules --exclude dist --exclude .DS_Store --exclude .claude \
  --exclude '.env' --exclude '.env.*' --exclude 'apps/server/data' \
  ./ "$HOST:$DIR/"

ssh "$HOST" "set -e; cd $DIR; ~/.bun/bin/bun install --frozen-lockfile; ~/.bun/bin/bun run build; sudo systemctl restart after-office; sleep 1; systemctl is-active after-office"
