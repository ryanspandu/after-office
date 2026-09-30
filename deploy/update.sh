#!/usr/bin/env bash
# Update the dashboard on the VPS from its git checkout (/opt/after-office): pull, install, build, restart. For a
# server that deploys from GitHub instead of deploy/sync.sh. Agents keep running (after-office-agents.service isn't
# touched). Your data (apps/server/data) and secrets (/etc/after-office.env) aren't in git: never touched either.
#
#   First time, after setup-vps.sh (as root):
#     bash update.sh --init https://github.com/<you>/after-office.git          (or git@github.com:… with a deploy key)
#   Every update after that:
#     sudo bash /opt/after-office/deploy/update.sh
#
# Options: --init <repo url>   make /opt/after-office a checkout of that repo (first time only)
#          --branch <name>     the branch to follow (default: main, or the checkout's current one)
#          --force             build and restart even when nothing new came in
# When the pull changed the server setup (deploy/ files), it says so: then run setup-vps.sh again, once.
set -euo pipefail

# the OFFICE_UPDATE_* overrides are for testing this script elsewhere; on the VPS the defaults are right
APP_USER=${OFFICE_UPDATE_USER:-office}
APP_DIR=${OFFICE_UPDATE_DIR:-/opt/after-office}
BUN=${OFFICE_UPDATE_BUN:-/home/$APP_USER/.bun/bin/bun}
HEALTH=${OFFICE_UPDATE_HEALTH:-http://127.0.0.1:8787/health}
REPO=""
BRANCH=""
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --init) REPO=${2:?--init needs the repo URL}; shift ;;
    --branch) BRANCH=${2:?--branch needs a name}; shift ;;
    --force) FORCE=1 ;;
    -h | --help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
  shift
done

bold() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
note() { printf '    %s\n' "$1"; }
warn() { printf '\033[33m    ! %s\033[0m\n' "$1"; }

id "$APP_USER" >/dev/null 2>&1 || { echo "No '$APP_USER' user: run deploy/setup-vps.sh on this server first." >&2; exit 1; }
[ -x "$BUN" ] || { echo "Bun isn't installed for $APP_USER ($BUN): run deploy/setup-vps.sh first." >&2; exit 1; }

# git, bun and the build run as the dashboard user (the checkout is theirs; agents can't read it). Bun's folder goes on
# PATH: the build's own scripts call `bun` by name, and sudo's PATH doesn't have ~/.bun/bin.
BUN_PATH="$(dirname "$BUN"):$PATH"
as_app() {
  if [ "$(id -un)" = "$APP_USER" ]; then PATH="$BUN_PATH" bash -c "$1"; else sudo -u "$APP_USER" -H env PATH="$BUN_PATH" bash -c "cd '$APP_DIR' && $1"; fi
}
if [ "$(id -un)" != "$APP_USER" ] && [ "$(id -u)" != 0 ]; then
  echo "Run this as root (sudo) or as $APP_USER." >&2
  exit 1
fi
cd "$APP_DIR"

if [ -n "$REPO" ]; then
  bold "Checkout of $REPO in $APP_DIR"
  if [ -d "$APP_DIR/.git" ]; then
    note "Already a git checkout: using it (drop --init for updates)."
  else
    BRANCH=${BRANCH:-main}
    # the folder isn't empty (apps/server/data, made by setup-vps.sh): init + fetch instead of clone. Data and .env
    # aren't in the repo, so the checkout leaves them as they are.
    as_app "git init -q && git remote add origin '$REPO' && git fetch -q origin '$BRANCH' && git checkout -q -f -B '$BRANCH' 'origin/$BRANCH'"
    FORCE=1
  fi
fi

[ -d "$APP_DIR/.git" ] || { echo "$APP_DIR isn't a git checkout. First time: bash update.sh --init <repo url> (see --help)." >&2; exit 1; }

bold "Pull"
BRANCH=${BRANCH:-$(as_app "git rev-parse --abbrev-ref HEAD")}
BEFORE=$(as_app "git rev-parse HEAD")
# only fast-forwards: local edits on the server are never merged or thrown away silently
if ! as_app "git fetch -q origin '$BRANCH' && git merge -q --ff-only 'origin/$BRANCH'"; then
  warn "Couldn't fast-forward to origin/$BRANCH (files changed on the server, or the history was rewritten)."
  warn "See what's different:  sudo -u $APP_USER git -C $APP_DIR status"
  exit 1
fi
AFTER=$(as_app "git rev-parse HEAD")
if [ "$BEFORE" = "$AFTER" ] && [ "$FORCE" = 0 ]; then
  note "Already up to date ($(as_app "git log -1 --format='%h %s'"))."
  exit 0
fi
CHANGED=$(as_app "git diff --name-only $BEFORE $AFTER" || true)
[ "$BEFORE" != "$AFTER" ] && note "$(as_app "git log --oneline $BEFORE..$AFTER" | wc -l | tr -d ' ') new commit(s): $(as_app "git log -1 --format='%h %s'")"

bold "Install and build"
as_app "'$BUN' install --frozen-lockfile && '$BUN' run build"

bold "Restart the dashboard (agents keep running)"
if [ -n "${OFFICE_UPDATE_RESTART:-}" ]; then bash -c "$OFFICE_UPDATE_RESTART"
elif [ "$(id -u)" = 0 ]; then systemctl restart after-office
else sudo systemctl restart after-office; fi
ok=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "$HEALTH" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ "$ok" = 1 ]; then note "Running ($(as_app "git log -1 --format='%h %s'"))."; else warn "Not answering yet: journalctl -u after-office -n 50"; fi

# the server's setup (services, Caddy, tmux, the installer itself) lives in deploy/: pulled, but not applied
SETUP=$(printf '%s\n' "$CHANGED" | grep -E '^deploy/' | grep -v '^deploy/update\.sh$' || true)
if [ -n "$SETUP" ]; then
  warn "The server setup changed in this update:"
  printf '%s\n' "$SETUP" | sed 's/^/      /'
  warn "Apply it once (runs the setup again with the options it was first run with; safe to re-run):"
  warn "  after-office setup"
fi
