# Deploying to a VPS

One Ubuntu VPS runs everything, split between two Unix users so that an agent cannot take over the dashboard:

- **Dashboard** (`after-office.service`, user `office`): Hono serves the built dashboard and the API on `127.0.0.1:8787`.
- **Agents** (`after-office-agents.service`, user `office-agent`): one tmux server with a real `claude` session per agent, logged in with your Claude Pro/Max subscription.
- **Caddy** in front: automatic HTTPS.

```
browser ──HTTPS──► Caddy :443 ──► dashboard 127.0.0.1:8787 (office) ──/run/after-office/tmux.sock──► tmux (office-agent) ── claude × n
                                          ▲                                                                  │
                                          └──────────── hooks / statusline / MCP (loopback, per-agent token) ┘
```

What an agent (even a prompt-injected one) **cannot** do:

- read the dashboard's code (`/opt/after-office`), database, backups or secrets (`/etc/after-office.env`, root-only, handed to the dashboard by systemd);
- read the dashboard process's environment or memory (another user);
- use sudo or setuid programs (`NoNewPrivileges`), or see `/home/office`;
- speak for another agent: every agent has its own hook/MCP token (an HMAC of `HOOK_TOKEN` and its id);
- reach Caddy's admin API (a root-only socket) or tmux commands from the browser terminal (no prefix key).

What remains: all agents share the `office-agent` user, so one agent can read or type into another agent's session, including the manager's. Treat the agents as one trust zone. That is why the manager's riskier actions (hiring, quality-check commands, and optionally every task) wait for your approval.

## Quick start: from GitHub, start to finish

Two commands, as root on a fresh VPS, when your code is in a (private) GitHub repository. Each part is explained in
the sections below.

```bash
# 1. a copy of the repo to run the setup from (any way you can clone it, e.g. your own key)
git clone git@github.com:<you>/after-office.git ~/after-office

# 2. everything else; --tailscale (private) or your domain (public)
bash ~/after-office/deploy/setup-vps.sh --tailscale --dev-tools --containers
#    or:  bash ~/after-office/deploy/setup-vps.sh office.example.com --dev-tools --containers
```

Run it in a terminal (not in the background): it stops twice to ask you something. What it does after the server
setup:

1. **The code.** Run from a clone, it takes the clone's `origin` and branch (or pass `--repo <url>` / `--branch <name>`;
   `--no-repo` skips this, e.g. when you use `deploy/sync.sh`). For a private repo over SSH it makes a read-only
   **deploy key** for the `office` user, prints it with the link to the repo's *Settings → Deploy keys*, and waits:
   add it there (leave "Allow write access" off), then press Enter. Then it checks the code out into
   `/opt/after-office`, builds and starts the dashboard (`update.sh --init`). The dashboard user never gets your own
   SSH keys, only this one, which can read this one repository.
2. **The dashboard login:** it asks for a username and a new password (written to `/etc/after-office.env`).
3. With `--tailscale`, before all that: the Tailscale login link (open it, sign in; the script carries on).

Left for you, printed at the end:

```bash
sudo -iu office-agent claude     # log the agents in with your Claude subscription once, then /exit
```

Then open the URL it printed. The first sign-in sets up two-factor (Google Authenticator); keep the recovery codes.

- **Every update:** push from your machine, then on the VPS `bash /opt/after-office/deploy/update.sh`.
- **The clone in `~/after-office`** is only for running `setup-vps.sh`. When an update says the server setup changed:
  `git -C ~/after-office pull`, then run the setup again with the same options (safe to re-run; the code and the
  login are left as they are).
- **Typed "skip" at the deploy key, or ran it without a terminal?** Add the key later
  (`cat /home/office/.ssh/github_deploy.pub`), then `bash ~/after-office/deploy/update.sh --init <repo url>` and create
  the login as root: `OFFICE_ENV_FILE=/etc/after-office.env /home/office/.bun/bin/bun
  /opt/after-office/apps/server/src/setup-auth.ts && systemctl restart after-office`.

## Requirements

- **VPS:** Ubuntu 22.04 or 24.04. The dashboard itself is small (about 50–100 MB). Each `claude` session uses roughly
  200–400 MB; what agents run (installs, builds, tests) is what needs the rest.

  | Agents | Size |
  |---|---|
  | A manager and a few agents that research, write or organise | 2 vCPU / 4 GB RAM / 40 GB SSD |
  | Plus one or two that write and build code (`--dev-tools`) | 4 vCPU / 8 GB RAM / 60 GB SSD |
  | Several coding agents, browsers for tests, a database | 4–8 vCPU / 16 GB RAM / 80 GB SSD |

- **DNS:** a domain whose A record points to the VPS (e.g. `office.example.com`). Not needed with Tailscale (below).
- **SSH:** with a key, as root or as your own user with sudo (e.g. `ubuntu`, on providers that don't hand out root).
  The setup turns off SSH password logins, but only if one of those has a key (so it can't lock you out).

## 1. Server setup (once)

```bash
scp -r deploy root@VPS:/root/after-office-deploy
ssh root@VPS 'bash /root/after-office-deploy/setup-vps.sh office.example.com'
```

Logged in as a user with sudo instead of root (the same options work):

```bash
scp -r deploy ubuntu@VPS:after-office-deploy
ssh -t ubuntu@VPS 'sudo bash ~/after-office-deploy/setup-vps.sh office.example.com'
```

Everything below marked "as root" then runs with `sudo` in front (`sudo systemctl restart after-office`,
`sudo -iu office-agent claude`, …). The script is safe to re-run. It does the following:

- **Packages:** tmux, git, acl, ufw, unattended-upgrades (automatic security updates) and Caddy.
- **Users:**
  - `office` (dashboard): `/opt/after-office` (mode 750) and its data (700).
  - `office-agent` (agents): `/home/office-agent/agents` for agent folders and `/home/office-agent/projects` for repos.
  - ACLs let the dashboard write agent settings there and read the agents' transcripts.
  - Your SSH key (that of the user who ran it with sudo, and root's) is added to `office` (for `sync.sh`), not to
    `office-agent`. A provider's root key that only says "log in as ubuntu" (a forced command) is left out.
- **Tools:** Bun for both users, Claude Code for `office-agent`.
- **Secrets:** `/etc/after-office.env` (root, 0600) with a fresh `SESSION_SECRET` and `HOOK_TOKEN`.
- **Services:**
  - `after-office-agents` and `after-office`, both with systemd sandboxing (read-only system, no new privileges, private /tmp, memory caps).
  - The Caddy site, which carries the security headers and body limits, and keeps its admin API on a unix socket.
- **Swap:** a 4 GB swap file when the machine has none (`--no-swap` skips it), so a build spike doesn't take the
  dashboard or SSH down.
- **Firewall:** ufw allows only SSH (the port sshd listens on: 22, or the `Port` you set in `sshd_config`), 80 and 443; with Tailscale, SSH and the tailnet only.
- **SSH:** keys only (see above).
- **Logs:** journald is capped at 200 MB / 30 days.
- **sudo:** `office` may run only `sudo systemctl restart after-office`.

### Private setup with Tailscale (recommended)

With Tailscale the dashboard is **not on the internet at all**. Only your own devices, logged into your Tailscale network (tailnet), can open it, at `https://after-office.<tailnet>.ts.net` with a real HTTPS certificate, so it still installs as an app. No domain, no DNS record, and no public web ports are needed.

1. **Tailscale account** (free for personal use). In the [admin console](https://login.tailscale.com/admin/dns): turn on **MagicDNS** and **HTTPS Certificates**.
2. **Set up the VPS** with `--tailscale` instead of a domain. `ssh -t` because it shows a login link to open once:
   ```bash
   ssh -t root@VPS 'bash /root/after-office-deploy/setup-vps.sh --tailscale'
   ```
   - The script:
     - installs Tailscale and logs the VPS in (name `after-office`; change it with `--hostname`);
     - runs `tailscale serve` for the dashboard;
     - closes ports 80/443;
     - sets `OFFICE_PUBLIC_URL`.
   - Unattended: pass an auth key, `TS_AUTHKEY=tskey-auth-… bash setup-vps.sh --tailscale`.
3. **Your devices:** install the Tailscale app (iPhone, Android, Mac, Windows), log in with the same account, then open `https://after-office.<tailnet>.ts.net`.
4. **In the admin console → Machines → after-office:** *Disable key expiry*, so the server never drops off the tailnet.

Options and tips:

- **Webhook-triggered cron jobs** need to be reachable by outside services (CI, GitHub).
  - Add `--funnel-trigger`. Tailscale Funnel then opens **only** `/trigger/…`, on port 8443: `https://after-office.<tailnet>.ts.net:8443/trigger/cron/<id>`. The dashboard itself stays private.
  - The cron's "Webhook trigger" shows this URL (`OFFICE_TRIGGER_URL`).
  - Funnel must be allowed for the machine in the tailnet policy. `tailscale funnel` prints how if it isn't.
- **SSH over Tailscale only.** Once it works, remove SSH from the internet too:
  ```bash
  ufw delete allow <your ssh port>/tcp   # the rule setup-vps.sh added (22, or the Port in sshd_config)
  ufw delete allow OpenSSH              # from an older setup, if it is there
  # (the tailnet is already allowed: ufw allow in on tailscale0)
  ```
  After that, `sync.sh` uses the tailnet name: `deploy/sync.sh office@after-office`.
- **Your own domain, still private** (e.g. `https://office.example.com`, DNS at Cloudflare):
  ```bash
  bash ~/after-office/deploy/setup-vps.sh --tailscale --domain office.example.com --dns cloudflare --dev-tools --containers
  ```
  - It asks for a Cloudflare API token (or takes `CF_API_TOKEN=…` from the environment): dash.cloudflare.com →
    My Profile → API Tokens → Create Token → template **Edit zone DNS**, Zone Resources: *Specific zone* → your domain.
    It's kept in `/etc/caddy/cloudflare.env` (root only) and handed to Caddy alone.
  - It sets the **A record** `office.example.com → the server's Tailscale IP (100.x.y.z)`, *DNS only*. Anyone can look
    the name up, but that address only answers inside your tailnet.
  - In the tailnet policy, allow your devices to reach the server on `tcp:443` and `tcp:13000-13009` (previews,
    see Previews below), e.g. a `"hosts": {"after-office": "100.x.y.z"}` entry and a grant with `"dst": ["after-office"]`.
  - **Caddy** serves the dashboard and the preview ports on that name. Its certificate comes from Let's Encrypt through
    a **DNS challenge** (a TXT record Caddy sets through the token), so no port is ever opened to the internet: 80/443
    stay closed, as with plain Tailscale. The packaged Caddy has no DNS modules, so the script installs Caddy's own
    build with the Cloudflare module (`/usr/bin/caddy.custom`, the package's binary kept as `caddy.default`); it isn't
    updated by apt, so run the setup again now and then (`rm /usr/bin/caddy.custom` first to fetch a fresh build).
  - `https://after-office.<tailnet>.ts.net` stops answering (Caddy takes 443 over). Web push: turn notifications on
    again from the app opened on the new address (a new address is a new app to the browser).
  - Back to the `.ts.net` name: run the setup again without `--domain`.
- **Share with someone else:** use *Share* on the machine in the admin console. They still need the dashboard login.
- **Switching:** you can switch from a public domain setup to Tailscale (or back) by running the script again with the other option.
- **Why Tailscale and not WireGuard by hand:** Tailscale *is* WireGuard, with the key exchange, NAT traversal, device list and HTTPS certificates handled for you.
  - If you'd rather have no third party at all, use plain WireGuard: a `wg0` interface on the VPS, one peer per device, `ufw allow 51820/udp`, and keep the Caddy setup bound to the WireGuard address.
  - That route needs your own domain and certificate for HTTPS, which the app install requires.

### Agents that write code

Every project can need something else: one runs Node 18 with MySQL, another Node 22 with Postgres and Redis. Nothing
project-specific is installed on the server itself; each project brings its own setup. Add these to the setup command
(also later, since the script is safe to run again):

- `--dev-tools`: the shared basics.
  - Node.js 22 LTS, build tools, Python (with venv and pip), jq, ripgrep, sqlite3 and the GitHub CLI.
  - The system libraries Playwright's Chromium needs.
  - [mise](https://mise.jdx.dev) for per-project runtime versions. A project's `.mise.toml` (e.g. `node = "18"`,
    `python = "3.11"`, `php = "8.3"`) picks the version in that folder; the agent runs `mise install`.
  - Agents have no sudo, so versions and global npm packages (`~/.npm-global`) go in their home.
- `--containers`: rootless Docker and Compose for the agents' user.
  - Each project keeps its databases and services (MySQL, Postgres, Redis, Mongo…) in its own `docker-compose.yml`,
    with its own versions and data. The agent starts them with `docker compose up -d`.
  - Containers run as `office-agent`, never as root, and there is no root Docker daemon or `docker` group.
  - The daemon runs in that user's own systemd session. The agents' sandbox only gets its socket (`DOCKER_HOST`).
  - Publish ports on `127.0.0.1` (`"127.0.0.1:3306:3306"`). The firewall blocks everything else from outside anyway.

For example, project A:

```yaml
# ~/projects/a/docker-compose.yml
services:
  mysql:
    image: mysql:8
    environment: { MYSQL_ROOT_PASSWORD: dev, MYSQL_DATABASE: app }
    ports: ["127.0.0.1:3306:3306"]
    volumes: [mysql:/var/lib/mysql]
  redis:
    image: redis:7
    ports: ["127.0.0.1:6379:6379"]
volumes: { mysql: {} }
```

```toml
# ~/projects/a/.mise.toml
[tools]
node = "18"
```

Two projects can't publish the same port at once: give the second one another port (`"127.0.0.1:3307:3306"`), or stop
the first (`docker compose down`).

Agents learn these conventions from the **Software engineering** office rules in their CLAUDE.md.
- **New agents:** the new agent form and the manager's hires pick them for a coding role (engineer, developer,
  full-stack…), and you can switch them on or off there.
- **Any agent, later:** open the agent → **CLAUDE.md → Office rules → Apply**. Only the marked rules blocks change;
  the rest of the file stays as it is.

**Or a cloud database (optional).** A project can use a hosted development database instead, such as Neon or Supabase
(Postgres), PlanetScale or Aiven (MySQL), or Upstash (Redis). Nothing to install: put its connection string in the
project's `.env`.

**System tools.** `--dev-tools` also installs what projects often need from the system:
- media: ImageMagick, GraphicsMagick, libvips, ffmpeg, Ghostscript, poppler (PDF), qpdf;
- libraries native packages build against: OpenSSL, libffi, zlib, image formats, Postgres/MySQL/SQLite clients,
  libxml, yaml and readline;
- git-lfs, zip and tree.

Agents have no sudo, so anything else goes one of two ways:
- the agent runs it from a Docker image (`docker run --rm -v "$PWD":/w -w /w <image> …`);
- you add it with `--apt "tesseract-ocr libreoffice"`. Run the setup again with that option: the rest is skipped when
  it's already done.

**React Native.** The JavaScript side (Expo, Metro, tests, lint) runs like any Node project.
- Android builds need `--android`: JDK 17 and the Android SDK in the agents' home (`ANDROID_HOME` is set for them).
  There's no emulator, since VPSs rarely allow the virtualisation it needs.
- iOS builds need macOS and Xcode, which a Linux server can't run. Use Expo's cloud builds (`eas build`), or have
  the agent work on your Mac.
- Try the app on your phone:
  - with Expo Go: `npx expo start --tunnel` gives a link that works from anywhere;
  - or install the build that `eas build` makes.

Docker doesn't help here: React Native builds need the Android SDK or Xcode, not a service in a container.

**Git and GitHub for the agents.** Each agent has its own git identities and SSH keys, set in the dashboard: open the
agent, **Overview → Git**.

- **Default identity:** a commit name, an email and an SSH key, used wherever no other identity applies. Leave the
  name and email empty to use git's own setting; `--dev-tools` sets a placeholder, "After Office agent".
- **More identities:** e.g. a client's GitHub account. Each has its own name, email and SSH key, and says where it's
  used, one rule per line:
  - a folder: `~/after-office/project/acme`, for the repos in it;
  - repos by where they're hosted: `github.com/acme` or `gitlab.com/team/app`, for SSH and HTTPS remotes alike;
  - an exact remote pattern: `git@github.com:acme/**`.

  Rules by remote need git 2.36 or newer. `--dev-tools` upgrades Ubuntu 22.04's git for that.
- **SSH keys:**
  - **Generate key:** the server makes an ed25519 key and shows only the public half. Copy it to a repo's
    **Settings → Deploy keys** (tick "Allow write access" to push), or to the account's SSH keys.
  - **Use my own key:** paste or pick a private key without a passphrase. It's never shown again.
  - Keys sit in the agents' home (`~/.ssh/after-office/<agent>/…`), readable only by the agents' user.
- **How it's applied:** each agent's session uses a gitconfig of its own (`GIT_CONFIG_GLOBAL`). That file includes
  the agents' `~/.gitconfig`, sets the default identity, and switches identity and key per repo with git's
  `includeIf`. Agents sharing one Unix user can still differ, and changes apply right away. A session started before
  it had this file restarts once it's idle, and the conversation continues.
- **Over HTTPS instead:** log the GitHub CLI in once as the agents' user, with a fine-grained token limited to their
  repositories (contents and pull requests only):

  ```bash
  sudo -iu office-agent gh auth login
  ```

- **Either way,** protect `main` so their work lands through pull requests you merge.

**What a coding agent can and can't do here**

| Works | How |
|---|---|
| Web apps (Next.js, Nuxt, SvelteKit, Laravel, Rails, Django, FastAPI, Go, Spring…) | mise versions per project, services in Compose |
| Databases, caches, queues, search, mail testing (MySQL, Postgres, Mongo, Redis, RabbitMQ, Meilisearch, Mailpit…) | per-project `docker-compose.yml` |
| Images, video, PDFs | ImageMagick, libvips, ffmpeg, poppler, Ghostscript |
| Browser tests, screenshots | Playwright / Puppeteer (system libraries installed) |
| React Native / Expo, Flutter (Android side) | `--android`; Flutter through mise |
| Linux builds of desktop apps (Electron; Tauri with `--apt "libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev"`) | Node / Rust through mise |
| Trying what it built | Projects → Running now (preview ports) |

| Doesn't | Instead |
|---|---|
| iOS / macOS builds | Expo cloud builds (`eas build`) or an agent on your Mac |
| Android emulator, other VMs | a real phone (Expo Go, an APK), or a cloud device farm |
| GPU work (training, local models) | a GPU machine or a hosted API |
| Deploying to production | your CI after you merge (agents hold no production credentials) |
| System packages on their own (no sudo) | a Docker image, or `--apt` on your next setup run |
| Privileged containers, host networking, ports below 1024 | ordinary containers on ports ≥ 1024 |

Anything that must keep running after an agent's turn goes in Compose (`restart: unless-stopped`) or `nohup`: a
restarted session ends the processes it started itself. Unused Docker images and build cache are pruned weekly; project
data in volumes stays.

Keep production credentials out of the agents' folders: all agents share one Unix user and can read each other's files.
Let them push to branches and deploy through your CI after you merge.

### Previews

Agents run the app they're working on (a dev server) on a preview port, 3000–3009 by default (`--preview-ports`
changes the range). **Projects → Running now** in the dashboard lists what's running, with a link to each.

- **On the server** the link is `https://<office host>:<port>` with Tailscale's own name, and
  `https://<your domain>:<port + 10000>` (e.g. `:13000` for an app on 3000) with a domain: Caddy holds the port it
  serves on, on every address, so it can't use the app's own. (With `--tailscale --domain`, allow those ports to your
  devices in the tailnet policy: `"ip": ["tcp:443", "tcp:13000-13009"]`.) It goes through the dashboard's preview proxy, which
  admits only someone signed in to the dashboard. It takes your session cookie off every request before it reaches
  the app, so an agent's app never sees it. Hot reload (WebSockets) works through it.
- **On a Mac** the link is simply `http://localhost:<port>`.
- The proxy tells dev servers they're on `localhost`, so Vite's host check passes. Apps that build absolute links
  should read `X-Forwarded-Host`.

## 2. Upload and build

From your machine, in the project folder:

```bash
deploy/sync.sh office@VPS
```

This rsyncs the code (readable by `office` only), then runs `bun install`, `bun run build` and restarts the dashboard.
The build runs on Bun alone, so the server needs no Node.js for it. Agents keep running. `.env*` files and `apps/server/data` on the VPS are never overwritten. Run the same command for every update.

### Or: deploy from GitHub

The VPS can follow your repository instead: `/opt/after-office` becomes a git checkout, and each update is one command
on the server (`deploy/update.sh`: pull, install, build, restart the dashboard). Agents keep running; your data and
`/etc/after-office.env` aren't in git and are never touched.

`setup-vps.sh` does steps 1 and 2 for you when run from a clone or with `--repo <url>` (see "Quick start" above). By
hand, e.g. for a server set up before that:

1. **A private repository?** Give the `office` user read-only access with a deploy key (not a token of your account):
   ```bash
   sudo -u office -H mkdir -p -m 700 /home/office/.ssh
   sudo -u office -H ssh-keygen -t ed25519 -N '' -C office@vps -f /home/office/.ssh/github_deploy
   sudo -u office -H sh -c 'ssh-keyscan github.com >> ~/.ssh/known_hosts && printf "Host github.com\n  IdentityFile ~/.ssh/github_deploy\n  IdentitiesOnly yes\n" >> ~/.ssh/config'
   cat /home/office/.ssh/github_deploy.pub
   ```
   On GitHub: the repository → Settings → Deploy keys → Add deploy key, paste it, and leave "Allow write access" off.
   Then use the SSH address below (`git@github.com:<you>/after-office.git`). A public repository needs none of this.
2. **The first time** (as root, after `setup-vps.sh`), from the copy of `deploy/` you ran the setup from:
   ```bash
   bash /root/after-office-deploy/update.sh --init git@github.com:<you>/after-office.git
   ```
   (Set up with sudo from your own user? `sudo bash ~/after-office-deploy/update.sh --init …`.)
   It checks the repository out into `/opt/after-office` (as `office`), builds and starts the dashboard. `--branch <name>`
   follows another branch than `main`. The copy in `/root` isn't needed after this: `rm -rf /root/after-office-deploy`.
3. **Every update:**
   ```bash
   sudo bash /opt/after-office/deploy/update.sh
   ```
   - Nothing new: it says so and stops. `--force` builds and restarts anyway.
   - It only fast-forwards: if files were edited on the server, it stops and tells you (nothing is merged or thrown away).
   - When the update changed the server setup (files in `deploy/`: services, Caddy, tmux), it lists them. Then run
     `setup-vps.sh` once more, with the options you used the first time (safe to re-run).

Use one way or the other: `deploy/sync.sh` from your machine, or `update.sh` from GitHub. Mixing them overwrites each
other's copy.

## 3. Login (once)

As root on the VPS:

```bash
OFFICE_ENV_FILE=/etc/after-office.env /home/office/.bun/bin/bun /opt/after-office/apps/server/src/setup-auth.ts
```

Choose a new password here, not the one from local development. The password isn't echoed. Changing it later signs every browser out.

Optional settings go in the same file:

- `OFFICE_TZ=Asia/Jakarta`
- notification channels (see `apps/server/.env.example`)

Then log the agents' Claude Code in with your subscription. This is interactive: it prints a URL, you open it and paste the code back.

```bash
sudo -iu office-agent claude     # "Claude account with subscription", finish the login, then /exit
```

If agents need git access to your repos, set up a deploy key for `office-agent` (not `office`). Keep it limited to those repos.

```bash
systemctl restart after-office
```

Open `https://office.example.com` and sign in. The first sign-in asks you to set up **two-factor**: scan the QR code with Google Authenticator (or another authenticator app), enter its code, and save the recovery codes it shows. From then on every sign-in needs the password and a code.

## Operating

| What | Command |
|---|---|
| Logs | `journalctl -u after-office -f` (agents: `-u after-office-agents`) |
| Restart the dashboard (agents keep running) | `sudo systemctl restart after-office` (as `office`) |
| List agent sessions | `sudo -u office-agent tmux -S /run/after-office/tmux.sock ls` (as root) |
| Look at an agent directly | `sudo -u office-agent tmux -S /run/after-office/tmux.sock attach -t ao-<name>` (no prefix key; close the terminal to leave) |
| Stop every agent | `systemctl restart after-office-agents` (they come back with `--resume`). The dashboard's "Restart all agents" button (in an offline agent's chat) shows this command on the VPS, since the agents' tmux server belongs to their own service there |
| Lost phone and recovery codes (turns two-factor off; the next sign-in sets it up again) | `cd /opt/after-office/apps/server && ~/.bun/bin/bun run auth:reset-2fa` (as `office`) |
| Update from GitHub (if you deploy that way) | `sudo bash /opt/after-office/deploy/update.sh` |
| Backup now | `cd /opt/after-office/apps/server && ~/.bun/bin/bun run backup` (as `office`; automatic daily, see below) |

- **Reboots:** after a reboot the dashboard restarts every agent with `--resume`, which continues its last conversation.
- **Production settings:**
  - Cookies are `Secure`, `SameSite=Strict` and `__Host-` prefixed.
  - Hono listens on `127.0.0.1` only (always, unless `OFFICE_HOST` is set).
  - The client IP comes from Caddy's `X-Forwarded-For`, trusted only from loopback.
- **Hooks never leave the machine.** `/hook`, `/statusline` and `/mcp` are only reached over loopback; Caddy returns 404 for them from outside.
- **Never run `bun run dev` on the VPS.** The dev server is for your own machine. `bun run dev:lan` opens it to your Wi-Fi for testing on a phone.

## On a Mac

One command sets everything up from a fresh checkout:

```bash
bash scripts/install-mac.sh
```

- **Tools:** it installs tmux (with Homebrew), Bun and Claude Code if they're missing.
- **Setup:** it runs `bun install`, asks for the dashboard login the first time, and builds the app.
- **Service:** it installs a launchd service (`com.afteroffice.dashboard`). The service starts the dashboard at
  `http://localhost:8787` when you log in and restarts it if it stops. Logs go to `~/Library/Logs/after-office.log`.
- **Options:**
  - `--no-service` skips the service (run `bun run start` yourself).
  - `--port 8790` uses another port.
  - `--dry-run` only shows the steps.
  - `uninstall` removes the service. Data, agents and login stay.
- **Updating:** `git pull && bash scripts/install-mac.sh`.

Agents pause while the Mac sleeps. Keep the checkout on the internal disk: a remounted external drive broke the agents'
tmux server once (every new session exited at once). The dashboard now starts tmux from your home folder, and "Restart
all agents" in an offline agent's chat fixes a server in that state.

## Local development

Agents run on their own tmux server, not your default one:

```bash
tmux -L after-office ls
tmux -L after-office attach -t ao-<name>
```

Several Claude accounts on one machine (separate config folders, e.g. `~/.claude-work` used as `CLAUDE_CONFIG_DIR=~/.claude-work claude`)? Set `OFFICE_CLAUDE_CONFIG_DIR=~/.claude-work` in `apps/server/.env` and restart. Every agent then uses that folder's login, settings, skills and MCP servers. Agents already running are restarted with it, and start a fresh conversation, because conversations are stored in the config folder.

Secrets from `apps/server/.env` never reach agent sessions, because they get an allowlisted environment. To pass extra variables through (for example `SSH_AUTH_SOCK`, so local agents can push with your key), set `OFFICE_AGENT_ENV=SSH_AUTH_SOCK`.

## Install as an app (PWA)

After Office can be installed like an app. It needs HTTPS (your VPS domain) or `localhost`; a plain-http LAN address such as `http://192.168.x.x:5173` can't be installed.

- **Android (Chrome, Brave):** menu → *Install app*, or ☰ → *Install app* in the dashboard. It opens full screen with its own icon. Long-press the icon for the shortcuts: Manager chat, Tasks, Needs your attention.
- **iPhone / iPad (Safari):** Share → *Add to Home Screen* (☰ → *Add to Home Screen* shows how). The installed app keeps its own login, separate from Safari: sign in once inside it.
- **Desktop (Chrome, Edge, Brave):** the install icon in the address bar, or the monitor icon in the navbar.

How it behaves:

- **Data is always live.** The service worker keeps only the app's static files (JS/CSS, icons). The API, the live event stream, chats and approvals always come from the server; nothing of them is stored on the device.
- **Offline.** When the server can't be reached, the app shows "Can't reach After Office" with a *Try again* button. It never shows an old copy of the dashboard.
- **Updates.** After a deploy, an open app shows "A new version is available · Reload". Nothing reloads by itself.
- **Coming back from the background.** The live connection is re-opened as soon as the app is visible again, so status and chats are up to date right away.

After changing `apps/web/public/logo.png`, run `bun run icons` in `apps/web` (needs Python with Pillow) to regenerate the app icons.

## Notifications and the quota brake

- **Push notifications.** Set up channels in the dashboard: bell icon → Automation → Notifications (saving one asks for your 2FA code; tokens are stored encrypted and never shown again). Or set them in `apps/server/.env` and restart; a channel in the .env wins over the dashboard's:
  - **This app** (Web Push, no other app): Automation → Notifications → This app → *Turn on here*, on each phone or computer. Android and desktop browsers work right away; on iPhone/iPad (iOS 16.4+) first add the dashboard to the Home Screen, open it from there, then turn them on. Needs HTTPS (the VPS address). The server makes its own key pair on first use; no Google/Apple/Firebase account, and the push services can't read the messages (they're encrypted for the device).
  - **ntfy**: `OFFICE_NTFY_URL=https://ntfy.sh/<long random topic>`, then subscribe to the same topic in the ntfy phone app. Anyone who knows the topic can read it, so make it long and random, or self-host ntfy and set `OFFICE_NTFY_TOKEN`.
  - **Telegram:** `OFFICE_TELEGRAM_BOT_TOKEN` (from @BotFather) and `OFFICE_TELEGRAM_CHAT_ID`.
  - **Anything else:** `OFFICE_WEBHOOK_URL`, which receives a JSON POST `{ event, title, text, url, at }`.
  - `OFFICE_PUBLIC_URL` is the link a notification opens.
  - Pick which events are pushed, and send a test, from the bell icon in the navbar.
- **Quota brake.** At a set share of the 5-hour or weekly plan limit (default 80%), automatic work waits: auto-start tasks, tasks waiting on others, the manager's new tasks. Cron runs in that time are skipped and reported. Held work starts on its own once usage drops. Anything you start by hand still runs.

## Projects, checks and hand-offs

- **Project brief** (Tasks → Projects) is added to the prompt of every task in that project, and the manager can read it (`list_projects`).
- **Quality check** is a project or task setting, for example `pnpm lint && pnpm test`.
  - It runs in the agent's folder **as the agents' user**, never as the dashboard, when the agent finishes a task. It has a 10-minute limit.
  - If it fails, the output goes back to the agent to fix, up to 2 times. After that the task goes to review marked "check failed".
  - You set it in the dashboard. The manager can propose one (`update_task`), but it only applies once you approve the command in "Needs your attention".
  - The Changes view's git commands also run as the agents' user, with repo-configured helpers (hooks, fsmonitor, textconv) switched off.
- **Changes view** in a task shows what the agent changed since the task started. It needs the agent's folder to be a git repo. Read-only: it takes a `git stash create` snapshot and never touches the index or your stash list.
- **Approval** (bell icon → Automation) holds the manager's new tasks in "Needs your attention". Rejecting one removes it and tells the manager.
- **Auto-assign** (same place) hands out auto-start tasks that have no agent: the manager picks someone with `assign_task`; without a manager, a free agent takes it.
- **The manager's powers** (MCP tools, manager only; workers get 403):
  - propose hires with `create_agent`. **Every hire waits for your approval**, and the card shows its name, role, model, permission mode, folder and brief.
    - Folders: `OFFICE_AGENTS_DIR/<name>` by default, or one the manager names inside `OFFICE_ROOT`.
    - Symlinks are resolved first; hidden folders (`~/.claude`, `~/.ssh`), the After Office install and folders already in use are refused.
    - The office holds at most `OFFICE_MAX_AGENTS` agents (default 12).
  - edit tasks with `update_task`: title, description, priority, deadline, agent, project, dependencies, check, and status todo/review/done.
  - delete tasks with `delete_task`. Tasks in progress can't be reassigned or deleted. You get a note when one of your own tasks is deleted.
- **Stuck work:**
  - a task whose agent goes offline for 2 minutes goes back to To do;
  - an agent silent for 30 minutes mid-task triggers a notification;
  - a finished turn with no report moves the task to review.
- **Webhook-triggered cron.** In a cron job's settings, "Webhook trigger" gives a secret URL, `POST /trigger/cron/<id>` with `Authorization: Bearer <token>`.
  - Limited to one run per minute. The quota brake applies.
  - The request body (up to 16 KB; the request itself is capped at 64 KB) is added to the prompt as data. The token is checked before the body is read.
  - This path is public on purpose. Regenerate the token if it leaks.

## Data, archive and backups

All persistent data is one SQLite file: `apps/server/data/after-office.db`. The `-wal` and `-shm` files next to it belong to it.

- **Archive.** Done tasks untouched for `OFFICE_ARCHIVE_DAYS` (default 30) stay in the database but are no longer sent to the dashboards. Browse, restore or delete them under Tasks → Archive. Reports keep only the newest 1000.
- **Daily backup.** The server writes a consistent, gzipped copy once a day to `data/backups/` and keeps the newest 14.
  - Settings: `OFFICE_BACKUP_DIR`, `OFFICE_BACKUP_KEEP`, and `OFFICE_BACKUP=false` to turn it off.
  - The backup files are readable by `office` only.
  - These backups live on the same disk. Copy them off the VPS now and then, for example `rsync -az office@VPS:/opt/after-office/apps/server/data/backups/ ./office-backups/`. They hold your prompts and reports, so keep them encrypted (e.g. with `age`). Keep a copy of `/etc/after-office.env` somewhere safe too: the two-factor secret, notification tokens and the push key are stored encrypted with its `SESSION_SECRET`, so a database restored without that file (or with a new secret) needs two-factor set up again (`auth:reset-2fa`) and the notification channels entered again.
- **Restore:**
  ```bash
  # as root
  systemctl stop after-office
  cd /opt/after-office/apps/server/data
  gunzip -c backups/after-office-<date>.db.gz > after-office.db && rm -f after-office.db-wal after-office.db-shm
  chown office:office after-office.db && chmod 600 after-office.db
  systemctl start after-office
  ```

## Security notes

- The dashboard can type into Claude Code sessions that run commands as `office-agent`, so treat the dashboard login like SSH access.
  - Use a long password. Two-factor (authenticator app codes) is required: set up at the first sign-in, asked on every sign-in, for a password change, and to turn on Boss mode.
  - Keep `bypassPermissions` off (`OFFICE_ALLOW_BYPASS`, default off).
- **Activity log:** every connector call an agent makes (Gmail, Drive…) is logged on the server: what it was called with (secrets masked), what came back, who let it run (automatically, or you, with device and IP), and why the agent was doing it (your chat, a task and who made it, a daily job, a webhook caller's IP, the manager and Boss mode). Left sidebar → Activity, an agent's Activity tab, CSV export. Kept 90 days.
- **Hooks:** the log and the connector gate rely on the hooks in each agent's `.claude/settings.local.json`. The server checks them every minute; if an agent changed them (or set `disableAllHooks`), they're put back, the session restarts when idle, and you get a Security notification.
- **Agent folder scope:** agents can only be created inside `OFFICE_ROOT`.
- **Login rate limit:**
  - after 5 failed logins an IP is locked for 15 minutes, doubling each time up to a day;
  - at most 20 failures a minute are allowed office-wide, and only two password checks run at once.
- **Sessions:** signing out ends the session on the server. "Sign out everywhere" is under the bell icon → Automation.
- **Signing everyone out:** use "Sign out everywhere", or change the password.
- **`HOOK_TOKEN`:** rotate it if it leaks. The dashboard restarts agents holding an old token by itself, keeping their conversation.
- **Webhook tokens** for cron jobs are stored hashed and shown once; regenerate one to replace it.
