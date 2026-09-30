#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 22.04/24.04 VPS. Run as root (logged in as root, or with sudo from your own user)
# from a copy of this deploy/ folder:
#   scp -r deploy root@VPS:/root/after-office-deploy
#
#   Public, on your domain (Caddy + Let's Encrypt):
#     ssh root@VPS 'bash /root/after-office-deploy/setup-vps.sh office.example.com'
#   Private, only on your Tailscale network (https://<name>.<tailnet>.ts.net, no public web ports):
#     ssh -t root@VPS 'bash /root/after-office-deploy/setup-vps.sh --tailscale'
#     ssh -t root@VPS 'bash /root/after-office-deploy/setup-vps.sh --tailscale --funnel-trigger'   # + public webhooks
#   (TS_AUTHKEY=tskey-… in the environment logs in without the interactive link.)
# Options for agents that write and run code (add them to either form above, or later on a re-run):
#     --dev-tools   Node.js 22 LTS, build tools, Python, jq, ripgrep, sqlite3, GitHub CLI, Playwright's browser libraries,
#                   and mise (each project picks its own Node/Python/PHP/Go… versions; agents install them in their home)
#     --containers  rootless Docker + Compose for the agents: each project runs its own MySQL/Postgres/Redis/… in
#                   containers, as the agents' user (never root; no Docker group)
#     --apt "pkg …"  extra Ubuntu packages the agents need (they have no sudo), e.g. --apt "tesseract-ocr libreoffice"
#     --android     JDK 17 and the Android SDK command-line tools (React Native / Android builds; see docs/deploy.md)
#     --preview-ports 3000-3009   ports agents run their apps on, opened from the dashboard (default 3000-3009)
#     --no-swap     don't add the 4 GB swap file (added only when the machine has no swap)
# Safe to run again.
#
# Two Unix users:
#   office        the dashboard (/opt/after-office, its database, the secrets in /etc/after-office.env)
#   office-agent  every Claude Code agent (its own tmux server, /home/office-agent/{agents,projects})
# Agents can't read the dashboard's code, database or secrets; the dashboard reaches the agents' folders and
# transcripts through ACLs and drives their tmux server through /run/after-office/tmux.sock.
set -euo pipefail

USAGE='usage: setup-vps.sh your.domain.com | setup-vps.sh --tailscale [--funnel-trigger] [--hostname NAME]  [--dev-tools] [--containers] [--apt "pkgs"] [--android] [--preview-ports 3000-3009] [--no-swap]'
DOMAIN=''
TAILSCALE=0
FUNNEL=0
TS_HOSTNAME=after-office
DEV_TOOLS=0
CONTAINERS=0
EXTRA_APT=''
ANDROID=0
PREVIEW_PORTS=3000-3009
SWAP=1
ARGS="$*"
while [ $# -gt 0 ]; do
  case "$1" in
    --tailscale) TAILSCALE=1 ;;
    --funnel-trigger) FUNNEL=1 ;;
    --hostname) TS_HOSTNAME=${2:?$USAGE}; shift ;;
    --dev-tools) DEV_TOOLS=1 ;;
    --containers) CONTAINERS=1 ;;
    --apt) EXTRA_APT=${2:?$USAGE}; shift ;;
    --android) ANDROID=1 ;;
    --preview-ports) PREVIEW_PORTS=${2:?$USAGE}; shift ;;
    --no-swap) SWAP=0 ;;
    -*) echo "$USAGE" >&2; exit 1 ;;
    *) DOMAIN=$1 ;;
  esac
  shift
done
if [ "$TAILSCALE" = 0 ] && [ -z "$DOMAIN" ]; then echo "$USAGE" >&2; exit 1; fi
if [ "$FUNNEL" = 1 ] && [ "$TAILSCALE" = 0 ]; then echo '--funnel-trigger needs --tailscale' >&2; exit 1; fi
# root, logged in as root or through sudo from your own user (e.g. "ubuntu" on providers that don't hand out root)
if [ "$(id -u)" != 0 ]; then echo "Run this as root: sudo bash $0 $ARGS" >&2; exit 1; fi
SUDO_HOME=''
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then SUDO_HOME=$(getent passwd "$SUDO_USER" | cut -d: -f6); fi
# the admins' SSH keys (one per line): the sudo user's, then root's. A key pinned to a forced command is skipped: some
# providers put root's key behind  command="echo Please login as ubuntu"  and copying that would lock the login out.
admin_keys() {
  for f in ${SUDO_HOME:+"$SUDO_HOME/.ssh/authorized_keys"} /root/.ssh/authorized_keys; do
    if [ -f "$f" ]; then grep -vE '^[[:space:]]*(#|$)' "$f" | grep -v 'command=' || true; fi
  done | awk '!seen[$0]++'
}
APP_USER=office
AGENT_USER=office-agent
APP_DIR=/opt/after-office
AGENT_HOME=/home/$AGENT_USER
ENV_FILE=/etc/after-office.env
HERE=$(cd "$(dirname "$0")" && pwd)

echo "==> packages"
apt-get update
apt-get install -y tmux git curl rsync unzip acl ufw ca-certificates gnupg unattended-upgrades \
  debian-keyring debian-archive-keyring apt-transport-https
if [ "$TAILSCALE" = 0 ] && ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi
# security updates install themselves
dpkg-reconfigure -f noninteractive unattended-upgrades

# builds and many agents at once can spike memory: a swap file keeps a spike from killing the dashboard or SSH
if [ "$SWAP" = 1 ] && [ -z "$(swapon --show --noheadings)" ]; then
  echo "==> swap: 4 GB at /swapfile"
  fallocate -l 4G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=4096
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 >/dev/null
  echo 'vm.swappiness=10' > /etc/sysctl.d/90-after-office-swap.conf
fi

if [ "$DEV_TOOLS" = 1 ]; then
  echo "==> dev tools for the agents: Node.js 22 LTS, build tools, Python, jq, ripgrep, sqlite3, GitHub CLI"
  if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  fi
  if ! command -v gh >/dev/null; then
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
    apt-get update
  fi
  # per-repo git identities by remote (Overview → Git) need git 2.36+; Ubuntu 22.04 ships 2.34
  if [ "$(git --version | awk '{split($3, v, "."); print v[1] * 100 + v[2]}')" -lt 236 ]; then
    apt-get install -y software-properties-common
    add-apt-repository -y ppa:git-core/ppa
    apt-get update
    apt-get install -y git
  fi
  apt-get install -y nodejs build-essential python3 python3-venv python3-pip jq ripgrep sqlite3 gh
  # what projects often need from the system: images, video, PDFs, and the headers native packages build against
  apt-get install -y git-lfs zip unzip tree imagemagick graphicsmagick libvips-tools ffmpeg ghostscript poppler-utils \
    qpdf pkg-config libssl-dev libffi-dev zlib1g-dev libjpeg-dev libpng-dev libwebp-dev libpq-dev \
    default-libmysqlclient-dev libsqlite3-dev libxml2-dev libxslt1-dev libyaml-dev libreadline-dev \
    postgresql-client default-mysql-client redis-tools \
    autoconf bison re2c libcurl4-openssl-dev libonig-dev libzip-dev libgd-dev libicu-dev libsodium-dev libgmp-dev libbz2-dev liblzma-dev tk-dev libncurses-dev
  # (the last line: what mise needs to build PHP, Ruby and Python versions from source)
  # the system libraries Playwright's Chromium needs (the browser itself goes in the agent's home per project)
  npx -y playwright@latest install-deps chromium
fi

if [ -n "$EXTRA_APT" ]; then
  echo "==> extra packages: $EXTRA_APT"
  # shellcheck disable=SC2086
  apt-get install -y $EXTRA_APT
fi

if [ "$ANDROID" = 1 ]; then
  echo "==> Android build tools: JDK 17 (the SDK itself goes in the agents' home, below)"
  apt-get install -y openjdk-17-jdk-headless
fi

if [ "$CONTAINERS" = 1 ]; then
  echo "==> rootless Docker for '$AGENT_USER' (containers run as that user, never as root)"
  apt-get install -y uidmap dbus-user-session slirp4netns fuse-overlayfs
  if ! command -v dockerd-rootless-setuptool.sh >/dev/null; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-ce-rootless-extras docker-compose-plugin
  fi
  # no root daemon: a root Docker socket is root access for whoever may use it
  systemctl disable --now docker.service docker.socket >/dev/null 2>&1 || true
  rm -f /var/run/docker.sock
  # Ubuntu 24.04 blocks unprivileged user namespaces unless the program is allowed (rootless Docker needs them)
  if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
    cat > /etc/apparmor.d/usr.bin.rootlesskit <<'EOF'
abi <abi/4.0>,
include <tunables/global>
/usr/bin/rootlesskit flags=(unconfined) {
  userns,
  include if exists <local/usr.bin.rootlesskit>
}
EOF
    systemctl restart apparmor.service
  fi
fi


echo "==> users '$APP_USER' (dashboard) and '$AGENT_USER' (agents)"
id "$APP_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$APP_USER"
id "$AGENT_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$AGENT_USER"
# the dashboard may reach the agents' socket dir; agents are in no group of the dashboard
usermod -aG "$AGENT_USER" "$APP_USER"
chmod 750 "/home/$APP_USER" "$AGENT_HOME"

install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_DIR"
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$APP_DIR/apps" "$APP_DIR/apps/server" "$APP_DIR/apps/server/data"
chmod 750 "$APP_DIR/apps" "$APP_DIR/apps/server"
install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 2770 "$AGENT_HOME/agents" "$AGENT_HOME/projects"
install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 700 "$AGENT_HOME/.claude"
install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 2750 "$AGENT_HOME/.claude/projects"

# ACLs: both users read and write agent folders (the dashboard writes their Claude Code settings), and the
# dashboard reads transcripts. Default entries apply to everything created later.
for d in "$AGENT_HOME/agents" "$AGENT_HOME/projects"; do
  setfacl -R -m "u:$APP_USER:rwX,u:$AGENT_USER:rwX" "$d"
  setfacl -R -d -m "u:$APP_USER:rwX,u:$AGENT_USER:rwX,g::rwX" "$d"
done
setfacl -m "u:$APP_USER:x" "$AGENT_HOME" "$AGENT_HOME/.claude"
setfacl -R -m "u:$APP_USER:rX" "$AGENT_HOME/.claude/projects"
setfacl -R -d -m "u:$APP_USER:rX" "$AGENT_HOME/.claude/projects"

# let your SSH key log in as the dashboard user too (for deploy/sync.sh): the key of whoever ran this with sudo, and
# root's. Added once each (a re-run adds only new ones); the dashboard user's own keys stay.
KEYS=$(admin_keys)
if [ -n "$KEYS" ]; then
  APP_KEYS=/home/$APP_USER/.ssh/authorized_keys
  install -d -m 700 -o "$APP_USER" -g "$APP_USER" "/home/$APP_USER/.ssh"
  touch "$APP_KEYS"
  printf '%s\n' "$KEYS" | while IFS= read -r key; do grep -qxF "$key" "$APP_KEYS" || printf '%s\n' "$key" >> "$APP_KEYS"; done
  chown "$APP_USER:$APP_USER" "$APP_KEYS"
  chmod 600 "$APP_KEYS"
else
  echo "    ! No SSH key for root${SUDO_USER:+ or $SUDO_USER}: add one for $APP_USER yourself before using deploy/sync.sh"
fi

if [ "$DEV_TOOLS" = 1 ]; then
  # agents have no sudo: global npm packages go to their home (on their PATH, see after-office-agents.service)
  sudo -iu "$AGENT_USER" bash -c 'mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global'
fi
if [ "$DEV_TOOLS" = 1 ]; then
  # mise: per-project runtime versions (.mise.toml), installed in the agent's home; its shims are on the agents' PATH
  sudo -iu "$AGENT_USER" bash -c '[ -x ~/.local/bin/mise ] || curl -fsSL https://mise.run | sh'
fi
if [ "$DEV_TOOLS" = 1 ]; then
  # a name on the agents' commits until you set a real one (docs/deploy.md: git and GitHub for the agents)
  sudo -iu "$AGENT_USER" bash -c 'git config --global user.name >/dev/null || git config --global user.name "After Office agent"
    git config --global user.email >/dev/null || git config --global user.email "agents@after-office.local"
    git config --global init.defaultBranch main'
fi
if [ "$CONTAINERS" = 1 ]; then
  # images, stopped containers and build cache pile up: cleared weekly (volumes, i.e. project data, are kept)
  cat > /etc/cron.weekly/after-office-docker-prune <<EOF
#!/bin/sh
sudo -iu $AGENT_USER env XDG_RUNTIME_DIR=/run/user/\$(id -u $AGENT_USER) DOCKER_HOST=unix:///run/user/\$(id -u $AGENT_USER)/docker.sock docker system prune -af --filter "until=168h" >/dev/null 2>&1 || true
EOF
  chmod 755 /etc/cron.weekly/after-office-docker-prune
fi
if [ "$ANDROID" = 1 ]; then
  # the Android SDK command-line tools, platform tools and one platform + build tools, in the agent's home
  sudo -iu "$AGENT_USER" bash -c '
    set -e
    export ANDROID_HOME=~/android-sdk
    if [ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
      mkdir -p "$ANDROID_HOME/cmdline-tools" && cd "$ANDROID_HOME/cmdline-tools"
      curl -fsSL -o tools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
      unzip -q tools.zip && rm tools.zip && mv cmdline-tools latest
    fi
    yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null || true
    "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "platform-tools" "platforms;android-35" "build-tools;35.0.0"
  '
  install -d /etc/systemd/system/after-office-agents.service.d
  cat > /etc/systemd/system/after-office-agents.service.d/android.conf <<EOF
[Service]
Environment=ANDROID_HOME=$AGENT_HOME/android-sdk
EOF
fi
if [ "$CONTAINERS" = 1 ]; then
  AGENT_UID=$(id -u "$AGENT_USER")
  grep -q "^$AGENT_USER:" /etc/subuid || usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$AGENT_USER"
  # the agent's own systemd user manager runs its Docker daemon, also when nobody is logged in
  loginctl enable-linger "$AGENT_USER"
  for _ in $(seq 1 20); do [ -S "/run/user/$AGENT_UID/bus" ] && break; sleep 0.5; done
  sudo -iu "$AGENT_USER" env XDG_RUNTIME_DIR="/run/user/$AGENT_UID" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$AGENT_UID/bus" \
    bash -c 'systemctl --user is-active --quiet docker || dockerd-rootless-setuptool.sh install'
  # agents reach it through DOCKER_HOST; their sandbox hides /run/user, so that one folder is let in
  install -d /etc/systemd/system/after-office-agents.service.d
  cat > /etc/systemd/system/after-office-agents.service.d/docker.conf <<EOF
[Service]
Environment=DOCKER_HOST=unix:///run/user/$AGENT_UID/docker.sock
BindPaths=/run/user/$AGENT_UID
EOF
fi

echo "==> bun for '$APP_USER'; bun and Claude Code for '$AGENT_USER'"
sudo -iu "$APP_USER" bash -c '[ -x ~/.bun/bin/bun ] || curl -fsSL https://bun.sh/install | bash'
sudo -iu "$AGENT_USER" bash -c '[ -x ~/.bun/bin/bun ] || curl -fsSL https://bun.sh/install | bash'
sudo -iu "$AGENT_USER" bash -c '[ -x ~/.local/bin/claude ] || curl -fsSL https://claude.ai/install.sh | bash'

if [ "$TAILSCALE" = 1 ]; then
  echo "==> Tailscale (the dashboard is reachable only from your tailnet)"
  command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
  systemctl enable --now tailscaled
  if ! tailscale status >/dev/null 2>&1; then
    # prints a login link unless TS_AUTHKEY is set; waits until you've logged in
    tailscale up --hostname="$TS_HOSTNAME" ${TS_AUTHKEY:+--auth-key="$TS_AUTHKEY"}
  fi
  TS_NAME=$(tailscale status --json | python3 -c 'import json, sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
  PUBLIC_URL="https://$TS_NAME"
else
  PUBLIC_URL="https://$DOMAIN"
fi

echo "==> secrets in $ENV_FILE (root only; systemd hands them to the dashboard)"
if [ ! -f "$ENV_FILE" ]; then
  (
    umask 077
    cat > "$ENV_FILE" <<EOF
# After Office secrets. Change the login with:
#   OFFICE_ENV_FILE=$ENV_FILE /home/$APP_USER/.bun/bin/bun $APP_DIR/apps/server/src/setup-auth.ts
SESSION_SECRET=$(openssl rand -hex 32)
HOOK_TOKEN=$(openssl rand -hex 32)
EOF
  )
fi
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"
# KEY=value in the env file, replacing an earlier value (re-runs, or switching between domain and Tailscale)
set_env() {
  sed -i "/^$1=/d" "$ENV_FILE"
  if [ -n "$2" ]; then echo "$1=$2" >> "$ENV_FILE"; fi
}
set_env OFFICE_PUBLIC_URL "$PUBLIC_URL"
# apps agents run on these ports open from the dashboard, through its preview proxy (127.0.0.1:<port + 10000>)
set_env OFFICE_PREVIEW_PORTS "$PREVIEW_PORTS"
set_env OFFICE_PREVIEW_PROXY true
# the ports as a list, for Tailscale / Caddy / the firewall below
PORT_LIST=$(echo "$PREVIEW_PORTS" | tr ',' '\n' | while read -r r; do
  a=${r%-*}; b=${r#*-}; [ -z "$b" ] && b=$a
  seq "$a" "$b"
done | awk '$1 >= 1024' | head -50)

echo "==> systemd services and tmux config"
install -d -m 755 /etc/after-office
install -m 644 "$HERE/etc/tmux.conf" /etc/after-office/tmux.conf
install -m 644 "$HERE/after-office-agents.service" /etc/systemd/system/after-office-agents.service
install -m 644 "$HERE/after-office.service" /etc/systemd/system/after-office.service
# deploy/sync.sh restarts the dashboard as the app user; allow exactly that (agents are not affected)
echo "$APP_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart after-office" > /etc/sudoers.d/after-office
chmod 440 /etc/sudoers.d/after-office
visudo -cf /etc/sudoers.d/after-office >/dev/null
systemctl daemon-reload
systemctl enable after-office-agents after-office
systemctl restart after-office-agents

if [ "$TAILSCALE" = 1 ]; then
  echo "==> Tailscale serve: $PUBLIC_URL -> the dashboard (HTTPS certificate from Tailscale)"
  # needs MagicDNS + HTTPS certificates on in the tailnet (the command prints a link to turn them on if they're off)
  tailscale serve --bg --https=443 http://127.0.0.1:8787
  # previews: https://<name>:<port> → the dashboard's preview proxy (signed-in only; strips the session cookie)
  for p in $PORT_LIST; do tailscale serve --bg --https="$p" "http://127.0.0.1:$((p + 10000))"; done
  if [ "$FUNNEL" = 1 ]; then
    # public, but only /trigger and on its own port: the dashboard on 443 stays tailnet-only
    tailscale funnel --bg --https=8443 --set-path=/trigger http://127.0.0.1:8787/trigger
    set_env OFFICE_TRIGGER_URL "https://$TS_NAME:8443"
  else
    tailscale funnel --https=8443 off >/dev/null 2>&1 || true
    set_env OFFICE_TRIGGER_URL ""
  fi
  # a Caddy from an earlier public setup would still answer on 80/443
  systemctl disable --now caddy >/dev/null 2>&1 || true
else
  echo "==> Caddy site for $DOMAIN"
  sed "s/office.example.com/$DOMAIN/" "$HERE/Caddyfile" > /etc/caddy/Caddyfile
  # previews: https://<domain>:<port> → the dashboard's preview proxy (signed-in only; strips the session cookie)
  for p in $PORT_LIST; do
    printf '\n%s:%s {\n\treverse_proxy 127.0.0.1:%s {\n\t\tflush_interval -1\n\t}\n}\n' "$DOMAIN" "$p" "$((p + 10000))" >> /etc/caddy/Caddyfile
  done
  systemctl restart caddy
fi

echo "==> firewall"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
if [ "$TAILSCALE" = 1 ]; then
  # no public web ports; everything from your devices comes in over the tailnet interface
  ufw delete allow 80/tcp >/dev/null 2>&1 || true
  ufw delete allow 443/tcp >/dev/null 2>&1 || true
  ufw allow in on tailscale0
  ufw allow 41641/udp comment 'tailscale direct connections'
else
  ufw allow 80/tcp
  ufw allow 443/tcp
  for p in $PORT_LIST; do ufw allow "$p/tcp" comment 'After Office preview'; done
fi
ufw --force enable

echo "==> SSH: keys only (only if you have a key, so this can't lock you out)"
if [ -n "$(admin_keys)" ]; then
  cat > /etc/ssh/sshd_config.d/10-after-office.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  if sshd -t; then systemctl reload ssh 2>/dev/null || systemctl reload sshd; fi
fi

echo "==> logs: keep journald small"
install -d /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/after-office.conf <<'EOF'
[Journal]
SystemMaxUse=200M
MaxRetentionSec=30day
EOF
systemctl restart systemd-journald

cat <<NEXT

Done. Next (see docs/deploy.md):
  1. From your machine:   deploy/sync.sh $APP_USER@<vps>
     (or from GitHub, here: bash $HERE/update.sh --init <repo url>; then sudo bash $APP_DIR/deploy/update.sh to update)
  2. On the VPS as root (or with sudo):
       OFFICE_ENV_FILE=$ENV_FILE /home/$APP_USER/.bun/bin/bun $APP_DIR/apps/server/src/setup-auth.ts   # dashboard login
       sudo -iu $AGENT_USER claude       # log the agents in with your Claude subscription once, then /exit
       sudo -iu $AGENT_USER gh auth login   # optional: GitHub for the agents (a fine-grained token for their repos)
  3. systemctl restart after-office  ->  $PUBLIC_URL
  4. First sign-in: set up two-factor (scan the QR code with Google Authenticator) and keep the recovery codes.
     Notifications (this app / ntfy / Telegram / webhook): bell icon -> Automation -> Notifications.
     Lost phone and recovery codes:  sudo -iu $APP_USER sh -c 'cd $APP_DIR/apps/server && ~/.bun/bin/bun run auth:reset-2fa'
  Back up $ENV_FILE with the database: the two-factor secret and notification tokens are encrypted with its SESSION_SECRET.
NEXT
if [ "$CONTAINERS" = 1 ]; then echo "  Containers: agents run  docker compose up -d  in a project (ports on 127.0.0.1 only). Check: sudo -iu $AGENT_USER env DOCKER_HOST=unix:///run/user/$(id -u "$AGENT_USER")/docker.sock docker info"; fi
if [ "$TAILSCALE" = 1 ]; then
  echo "  Tailscale: open $PUBLIC_URL on a device logged into the same tailnet (Tailscale app on your phone)."
  if [ "$FUNNEL" = 1 ]; then echo "  Webhooks (public): https://$TS_NAME:8443/trigger/cron/<id>"; fi
  echo "  Tip: in the Tailscale admin console, turn off key expiry for this machine so it never drops off the tailnet."
fi
