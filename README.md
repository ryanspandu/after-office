# After Office

A 3D isometric office for Claude Code agents running 24/7 in tmux on a VPS. Each agent is a character
with its own desk and PC. Idle agents play with the office cat, shoot pool or take a coffee break, and
they meet in the meeting room.

The office is driven by real Claude Code sessions (**Live**) or a built-in simulation (**Demo**). No LLM is ever
called for the visualization: it's all derived from Claude Code's hooks, statusline and transcripts.

## Run

On a Mac, one command installs the tools, builds the app and runs it as a background service (see
[docs/deploy.md](docs/deploy.md#on-a-mac)):

```bash
bash scripts/install-mac.sh
```

By hand, or while working on the code:

```bash
bun install
bun --cwd apps/server run auth:setup   # create the dashboard login (writes apps/server/.env)
bun run dev                            # web on :5173, Hono API on :8787 (OFFICE_PORT)
bun run test                           # server unit tests
E2E_PASSWORD=… bun scripts/e2e-live.ts # full live test with a throwaway QA agent (~6 min, uses a few tokens)
```

Production: `bun run build` then `bun run start`. One process serves the dashboard and the API. Its cookies are HTTPS-only;
on plain `http://localhost` set `OFFICE_SECURE_COOKIE=false` (the Mac installer's service does). See
**[docs/deploy.md](docs/deploy.md)** for the VPS setup (systemd + Caddy HTTPS + `claude` login).

## Auth

The dashboard is single-owner and everything under `/api` requires a session.

- `bun run auth:setup` (in `apps/server`) sets `OFFICE_USER` and an argon2id `OFFICE_PASSWORD_HASH`. The hash is stored base64-encoded because `.env` loaders expand `$`. The script also generates `SESSION_SECRET` and `HOOK_TOKEN` if they are missing. Run it again to change the password.
- Two-factor is required: the first sign-in sets it up (QR code for Google Authenticator or another authenticator app, plus 8 one-time recovery codes); after that every sign-in asks for a 6-digit code. Lost phone and recovery codes: `bun run auth:reset-2fa` on the server.
- Boss mode (Automation → Manager & hand-offs) lets the manager delegate, message agents and send work back without approvals for 4–12 hours or until a date and time you pick (up to 7 days). Turning it on asks for a two-factor code; hires, connector writes and quality checks still ask you.
- Sessions are signed `HttpOnly` + `SameSite=Lax` cookies: 12 h, or 30 days with "keep me signed in". They are `Secure` when `NODE_ENV=production`. Changing `SESSION_SECRET` signs everyone out.
- Logins lock for 15 min after 5 failures, counted per IP and per username. Behind Caddy/nginx, set `OFFICE_TRUST_PROXY=true`.
- Write requests must be `application/json` (CSRF guard).
- Claude Code hooks call `POST /hook` with `Authorization: Bearer $HOOK_TOKEN`.
- See `apps/server/.env.example` for all settings. Serve the dashboard over HTTPS only.

## Layout

- `apps/web`: Vite + React + @react-three/fiber
  - `src/scene/layout.ts`: every coordinate (desks, meeting seats, lounge spots, obstacles)
  - `src/scene/Agent.tsx`: procedural character, poses and walking along A* paths (`pathing.ts`)
  - `src/scene/DayNight.tsx`: lighting that follows the office clock
  - `src/ui/*`: navbar (metrics, tokens, clock/timezone), cron + tasks, agents, human-in-the-loop queue
  - `src/state/*`: zustand stores, live sync (`live.ts`), demo simulation
- `apps/server`: Hono
  - `src/agents/*`: tmux manager, hook/statusline ingest, state machine, transcripts, reconciler, web terminal
  - `src/work/work.ts`: tasks, cron scheduler, prompt queue
  - `src/routes/*`: `/api` routes; `/api/events` is the SSE stream
- `deploy/`: systemd unit, Caddyfile, VPS setup and sync scripts
- `packages/shared`: types shared by web and server

## Live mode (real Claude Code sessions)

Each agent is a real `claude` CLI running in its own tmux session on the server, logged in with your Claude subscription. The dashboard never calls a model itself: every animation and status comes from Claude Code's hooks, statusline and transcript. See `docs/spike-claude-code.md` for what each signal contains.

Needs `tmux` and `claude` on the server's PATH (`TMUX_BIN` / `CLAUDE_BIN` to override), and `claude` logged in once.

- **Creating an agent** (dashboard → Add agent, Live) does four things:
  - Creates the folder if it's missing.
  - Merges hooks and a statusline into `<folder>/.claude/settings.local.json`.
  - Writes `CLAUDE.md` if the folder has none.
  - Starts `claude --model … --permission-mode … --session-id …` in the tmux session `ao-<name>`. The "trust this folder" dialog is answered automatically.
- **Hooks → `POST /hook`, statusline → `POST /statusline`.** Both authenticate with `HOOK_TOKEN`, which is passed to the session as `AO_HOOK_TOKEN`.
  - **Permission prompts and AskUserQuestion** are held open until you answer them in "Needs your attention". If you don't answer within about 10 minutes, the normal prompt stays in the terminal.
  - **Plan approvals** are answered by pressing the plan dialog's keys.
- **Changing the model** restarts the session with `--resume`, so the conversation continues. The dashboard refuses `/model`, because in the TUI it rewrites your global default.
- **Sessions that die** are restarted automatically. Set `OFFICE_AUTO_RESTART=false` to turn this off.
- **Token usage** is read from `~/.claude/projects/**/<session>.jsonl`. Each message is counted once, deduplicated by message id + request id.
- **Data** is stored in `apps/server/data/after-office.db` (`OFFICE_DATA_DIR`). Days are counted in `OFFICE_TZ` (default `Asia/Jakarta`).
- **Safety:** `bypassPermissions` is refused unless `OFFICE_ALLOW_BYPASS=true`. Agent folders must be inside `OFFICE_ROOT` (default: the folder containing this checkout, plus `$HOME`). An agent's folder can be changed later in its Overview tab; it then starts a new conversation there.

### Tasks and cron (live)

Tasks, projects, cron jobs and the office timezone are stored on the server and pushed to every open dashboard.

- **Start on agent** (task detail) types the task into the agent's session: title, project, priority, deadline and description.
  - The task moves to *In progress*, then to *Review* when the agent finishes its turn.
  - *Done* is always set by you.
- **Cron jobs** are run by the server in the office timezone, even with no dashboard open.
  - A slot missed by up to 5 minutes (e.g. during a restart) still fires; each slot fires once.
  - **Fresh context** sends `/clear` before the prompt.
- **Busy agents:** a task start or cron prompt for an agent that is busy waits in a queue. It is sent the next time the agent is idle, and the Agents panel shows the queued count.

### Manager (orchestrator)

**Hire manager** in the Agents panel starts one special agent (Opus by default, folder `~/after-office/<name>`, e.g. `~/after-office/marcus`). You talk to it in its own panel: the **Manager** button in the navbar, or the dock on phones.

The manager is a normal Claude Code session, connected to After Office through an MCP server that Hono serves on loopback (`/mcp`).

- **How it's connected:** its folder gets
  - a `.mcp.json` for the `after-office` server, authenticated with `HOOK_TOKEN` and its agent id;
  - a `settings.local.json` that pre-approves the server (`enabledMcpjsonServers`) and allows its tools (`mcp__after-office`);
  - a `CLAUDE.md` that describes the role.
- **Tools:**
  - `list_agents`
  - `delegate_task`: creates a tracked task and types it into the agent's session, or queues it
  - `message_agent`
  - `list_tasks` / `get_task`
  - `list_reports`
  - `notify_user`: puts a note in Reports
- **Reports come back automatically.** When a delegated task finishes, its report is typed into the manager's chat (`[After Office] Report from …`). The manager then follows up or sums up for you.
- **In the dashboard:** delegated tasks carry a crown. Agents who just got one show a briefing marker in the office.
- **Cost:** the manager uses your plan like any agent; every forwarded report is one manager turn. The server side (delegation, queue, reports, visuals) never calls a model.
- **Limits:** only one manager per office. It can't delegate to itself or to offline agents, and at most 5 prompts can wait per agent.

Switch to **Demo** in the Agents panel to use the built-in simulation instead.
