#!/usr/bin/env bash
# After Office on a Mac, from a fresh checkout: tools, dependencies, dashboard login, build, and a background
# service (launchd) that starts the dashboard when you log in and restarts it if it stops. Safe to run again: it's
# also how you update (git pull, then run it again).
#
#   bash scripts/install-mac.sh                install or update, with the background service
#   bash scripts/install-mac.sh --no-service   everything but the service (run it yourself: bun run start / bun run dev)
#   bash scripts/install-mac.sh --port 8790    another port for the dashboard (default 8787)
#   bash scripts/install-mac.sh --dry-run      only show what it would do
#   bash scripts/install-mac.sh uninstall      stop and remove the service (your data, agents and login stay)
set -euo pipefail

LABEL=com.afteroffice.dashboard
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/after-office.log"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT=8787
SERVICE=1
DRY=0
ACTION=install
while [ $# -gt 0 ]; do
  case "$1" in
    --no-service) SERVICE=0 ;;
    --port) PORT=${2:?--port needs a number}; shift ;;
    --dry-run) DRY=1 ;;
    uninstall) ACTION=uninstall ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
  shift
done

bold() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
note() { printf '    %s\n' "$1"; }
warn() { printf '\033[33m    ! %s\033[0m\n' "$1"; }
run() {
  if [ "$DRY" = 1 ]; then printf '    [dry-run] %s\n' "$*"; else "$@"; fi
}

[ "$(uname -s)" = Darwin ] || { echo "This installer is for macOS. On a Linux server use deploy/setup-vps.sh (docs/deploy.md)." >&2; exit 1; }

stop_service() {
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
}

if [ "$ACTION" = uninstall ]; then
  bold "Removing the background service"
  if [ "$DRY" = 1 ]; then note "[dry-run] launchctl bootout gui/$(id -u)/$LABEL; rm $PLIST"; else stop_service; rm -f "$PLIST"; fi
  note "Done. Your data (apps/server/data), agents and login are untouched. Agents keep running in tmux:"
  note "  tmux -L after-office ls        (stop them all: tmux -L after-office kill-server)"
  exit 0
fi

bold "Tools"
if ! command -v brew >/dev/null 2>&1; then
  warn "Homebrew is needed for tmux. Install it (it asks for your password), then run this again:"
  note '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  exit 1
fi
command -v tmux >/dev/null 2>&1 && note "tmux $(tmux -V | cut -d' ' -f2)" || run brew install tmux

BUN=$(command -v bun || true)
[ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ] && BUN="$HOME/.bun/bin/bun"
if [ -z "$BUN" ]; then
  run bash -c 'curl -fsSL https://bun.sh/install | bash'
  BUN="$HOME/.bun/bin/bun"
fi
[ "$DRY" = 1 ] && [ ! -x "$BUN" ] || note "bun $("$BUN" --version)"

CLAUDE=$(command -v claude || true)
[ -z "$CLAUDE" ] && [ -x "$HOME/.local/bin/claude" ] && CLAUDE="$HOME/.local/bin/claude"
if [ -z "$CLAUDE" ]; then
  run bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
  CLAUDE="$HOME/.local/bin/claude"
fi
[ "$DRY" = 1 ] && [ ! -x "$CLAUDE" ] || note "Claude Code $("$CLAUDE" --version 2>/dev/null | head -1)"

case "$ROOT" in
  /Volumes/*)
    warn "This checkout is on an external drive ($ROOT)."
    warn "If the drive isn't mounted when you log in, the service can't start (it keeps retrying). An internal disk is safer."
    ;;
esac

bold "Dependencies"
cd "$ROOT"
run "$BUN" install

bold "Dashboard login"
ENV_FILE="$ROOT/apps/server/.env"
if [ -f "$ENV_FILE" ] && grep -q '^OFFICE_PASSWORD_HASH=' "$ENV_FILE" && grep -q '^HOOK_TOKEN=.' "$ENV_FILE"; then
  note "Already set up in apps/server/.env (change it in the dashboard: Profile → Change password)."
elif [ -t 0 ]; then
  note "Choose the username and password for the dashboard:"
  (cd "$ROOT/apps/server" && run "$BUN" run auth:setup)
else
  warn "No login yet, and this isn't an interactive terminal. Run: cd apps/server && bun run auth:setup"
fi

bold "Build"
run "$BUN" run build

write_plist() {
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$BUN</string><string>src/index.ts</string></array>
  <!-- apps/server: the dashboard reads its .env (login, secrets) from here -->
  <key>WorkingDirectory</key><string>$ROOT/apps/server</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>OFFICE_PORT</key><string>$PORT</string>
    <!-- plain http on localhost: cookies are not HTTPS-only here -->
    <key>OFFICE_SECURE_COOKIE</key><string>false</string>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$PATH_VALUE</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
}

if [ "$SERVICE" = 0 ]; then
  bold "Done (no background service)"
  note "Start it:  bun run start   → http://localhost:$PORT   (or bun run dev while working on the code)"
else
  bold "Background service ($LABEL)"
  PATH_VALUE="$(dirname "$BUN"):$(dirname "$CLAUDE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  # something else on the port (e.g. `bun run dev`) would make the service fail over and over: checked below
  if [ "$DRY" = 1 ]; then
    note "[dry-run] write $PLIST, then launchctl bootstrap gui/$(id -u) $PLIST"
  else
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    stop_service
    write_plist
    BUSY=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $1" (pid "$2")"}' | head -1)
    if [ -n "$BUSY" ]; then
      warn "Port $PORT is in use by $BUSY (a dev server?). The service is installed but not started."
      warn "Stop that, then: launchctl bootstrap gui/$(id -u) $PLIST   (or run this again)"
    else
      launchctl bootstrap "gui/$(id -u)" "$PLIST"
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
        sleep 1
      done
      if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then note "Running on http://localhost:$PORT"; else warn "Not answering yet; see $LOG"; fi
    fi
  fi
  note "Logs:       $LOG"
  note "Restart:    launchctl kickstart -k gui/$(id -u)/$LABEL"
  note "Remove:     bash scripts/install-mac.sh uninstall"
fi

bold "Next"
note "1. Log Claude Code in once with your subscription (skip if you already use claude): run  claude  and follow the steps, then /exit."
note "   Using another Claude config folder (e.g. ~/.claude-work)? Set OFFICE_CLAUDE_CONFIG_DIR in apps/server/.env, then restart."
note "2. Open http://localhost:$PORT, sign in, and hire your manager (Agents → Hire manager)."
note "3. Agents stop while the Mac sleeps. To keep them working with the lid open on power: System Settings → Battery →"
note "   Options → Prevent automatic sleeping on power adapter when the display is off."
note "Update later: git pull && bash scripts/install-mac.sh"
