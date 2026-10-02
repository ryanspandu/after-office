/** What an agent is doing right now. Derived from Claude Code hooks (never from an LLM). */
export type AgentStatus = 'working' | 'waiting' | 'idle' | 'meeting' | 'offline'

/** Claude Code permission modes, as reported in hook payloads (`permission_mode`). */
export type LiveMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk'

export interface RateLimits {
  fiveHourPct: number | null
  sevenDayPct: number | null
  fiveHourResetsAt: number | null
  sevenDayResetsAt: number | null
  /**
   * When these were last fresh (ms): Claude Code reports the plan usage of its latest API reply, so an idle session
   * keeps sending old numbers. Only a session that is working counts; usage elsewhere (Claude desktop, claude.ai) shows
   * up after the next one.
   */
  checkedAt?: number | null
}

/** A manager hands work to the other agents (via the after-office MCP server) and reports back to you. */
export type AgentKind = 'worker' | 'manager'

/** How an agent's character looks in the office (chosen, never guessed from its name). */
export type AgentFigure = 'man' | 'woman'

/**
 * Office rules: sets of instructions the dashboard keeps in an agent's CLAUDE.md, each between its own markers so the
 * rest of the file is never touched. "office" is always there; the others are picked per agent (new agent form, hire,
 * or the CLAUDE.md tab).
 */
export const RULE_PACKS = [
  { id: 'office', label: 'Working in After Office', description: 'Reports, subagents, where results go, asking before risky steps.', always: true },
  { id: 'engineering', label: 'Software engineering', description: 'Per-project runtimes (mise) and services (Docker Compose), preview ports, long-running processes, no sudo.' },
] as const
export type RulePackId = (typeof RULE_PACKS)[number]['id']
export const isRulePack = (v: unknown): v is RulePackId => RULE_PACKS.some((p) => p.id === v)
/** Roles that write code get the engineering rules by default. */
export const looksLikeCoding = (role?: string | null) =>
  /engineer|develop|dev\b|programm|coder|coding|full.?stack|front.?end|back.?end|software|devops|sre|mobile|android|ios|web|qa|test/i.test(role ?? '')
/** The rules a new agent starts with: the office's, plus engineering for a coding role. Office rules are only about
 *  After Office itself and its server; know-how (marketing, SEO, research…) belongs in skills. */
export const defaultRulePacks = (role?: string | null): RulePackId[] => ['office', ...(looksLikeCoding(role) ? (['engineering'] as const) : [])]
/** One of an agent's git identities: its name, email and SSH key for the folders or repos in `match`. */
export interface GitIdentity {
  id: string
  label: string
  name: string
  email: string
  /** folders (/…, ~/…) or repos by remote (github.com/acme) */
  match: string[]
  sshKey?: { publicKey: string; fingerprint: string }
}
/** How hard Claude Code thinks (`claude --effort`); unset: Claude Code's own default. Higher uses the plan faster. */
export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: AgentEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const isEffort = (v: unknown): v is AgentEffort => typeof v === 'string' && (EFFORTS as string[]).includes(v)

export interface AgentInfo {
  id: string
  name: string
  /** Live: project folders outside its own folder it may work in (added when a task there starts) */
  extraDirs?: string[]
  kind?: AgentKind
  /** its character in the office; unset: the dashboard picks one per desk */
  figure?: AgentFigure
  /** its character's look: the dashboard draws hair, hat, glasses… from this number (random for each new agent) */
  style?: number
  /** thinking effort it runs with; unset: Claude Code's default */
  effort?: AgentEffort
  /** who its commits are by (unset: git's own config) */
  git?: { name?: string; email?: string }
  /** its SSH key for git (public half only) */
  sshKey?: { publicKey: string; fingerprint: string }
  /** more git identities, each for the projects its rules match (folders or repos); the one above is the default */
  gitIdentities?: GitIdentity[]
  /** connectors it may use (their tool prefixes, e.g. mcp__claude_ai_Gmail); null: every one (set up before this) */
  connectors?: string[] | null
  /** of those, the ones it may also write with (send, create, edit, delete…); the others are read-only */
  connectorsWrite?: string[]
  /** of those, the ones whose reading also waits for the owner (Read turned off) */
  connectorsReadAsk?: string[]
  /** pinned to the top of the agents list (on every device) */
  pinned?: boolean
  status: AgentStatus
  /** Short description of the current task (last prompt / todo). */
  task?: string
  /** Last tool used, e.g. Edit, Bash, Read. */
  tool?: string
  tmuxSession?: string
  cwd?: string
  updatedAt: number
  // ── live-only fields (present for agents backed by a real Claude Code session) ──
  /** Stable desk index assigned by the server. */
  desk?: number
  role?: string
  /** Model id reported by the statusline, e.g. "claude-sonnet-5". */
  model?: string
  modelName?: string
  permissionMode?: LiveMode
  /** What kind of input the agent is waiting for. */
  waitingFor?: 'permission' | 'plan' | 'question'
  sessionId?: string
  title?: string
  costUsd?: number
  contextPct?: number | null
  lastMessage?: string
  error?: string
  /** Tokens in the context window now, and its size (from the statusline) */
  contextTokens?: number
  contextSize?: number
  /** Replies the dashboard user hasn't seen in the Chat tab yet. */
  unread?: number
  /** Live: its side sessions (extra chats the owner opened, each its own Claude Code process), open and recently closed */
  sessions?: SideSessionInfo[]
}

/**
 * One of an agent's side sessions: a second (third…) Claude Code process in its folder, for chatting in parallel with
 * the owner. Tasks, daily jobs and the manager's messages always go to the main session; a side session is the owner's.
 */
export interface SideSessionInfo {
  /** s2, s3, … */
  key: string
  /** its conversation's title (from Claude Code), when it has one */
  title?: string
  /** running (its process is up); closed ones can be opened again */
  open: boolean
  status: AgentStatus
  waitingFor?: 'permission' | 'plan' | 'question'
  tool?: string
  permissionMode?: LiveMode
  costUsd?: number
  contextPct?: number | null
  lastMessage?: string
  unread?: number
  createdAt: number
  closedAt?: number
}

/** Something a human has to answer, created from a held PermissionRequest hook. */
export interface LiveFollowUp {
  id: string
  agentId: string
  /** asked in one of the agent's side sessions (unset: its main session) */
  sessionKey?: string
  /** `delegation`: the manager wants to hand out a task and approval is on */
  kind: 'permission' | 'plan' | 'question' | 'delegation' | 'hire' | 'check' | 'daily'
  tool: string
  /** One-line summary (command, file, first question). */
  message: string
  /** Full tool input: Bash command, plan markdown, AskUserQuestion questions… */
  input: Record<string, unknown>
  createdAt: number
}

// ── models ──
// What an agent can run on (`claude --model`). Aliases follow Claude Code's newest of each family; a full id pins one.
export const MODELS = [
  { value: 'opus', label: 'Opus 5.5', hint: 'most capable' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'newest Sonnet' },
  { value: 'sonnet', label: 'Sonnet 5', hint: 'balanced' },
  { value: 'haiku', label: 'Haiku 4.5', hint: 'fast & cheap' },
] as const
export type ModelChoice = (typeof MODELS)[number]['value']
/** New agents and hires, unless someone picks another. */
export const DEFAULT_MODEL: ModelChoice = 'claude-sonnet-5-5'
export const MODEL_CHOICES = MODELS.map((m) => m.value) as [ModelChoice, ...ModelChoice[]]
export const isModelChoice = (v: unknown): v is ModelChoice => MODEL_CHOICES.includes(v as ModelChoice)
/** A running model id ("claude-sonnet-5-5[1m]", "claude-opus-5-5") → the choice it is, for the dropdowns. */
export function modelChoiceOf(id?: string | null): string {
  if (!id) return DEFAULT_MODEL
  if (isModelChoice(id)) return id
  if (/sonnet-5-5/.test(id)) return 'claude-sonnet-5-5'
  return MODELS.find((m) => id.includes(m.value))?.value ?? id
}

/** What the owner changed in a hire before approving it (Needs your attention → the hire's details). */
export interface HireEdits {
  name?: string
  role?: string
  model?: ModelChoice
  mode?: 'default' | 'acceptEdits' | 'plan' | 'auto'
  figure?: AgentFigure
  /** connectors it may use (tool prefixes) */
  connectors?: string[]
  /** thinking effort; null: Claude Code's default */
  effort?: AgentEffort | null
  /** office rules for its CLAUDE.md (RULE_PACKS ids) */
  rules?: string[]
}

/**
 * A connector (MCP server) of the Claude account the agents use: from claude.ai, a plugin, or added by hand. Agents
 * get none by default; the owner turns them on per agent.
 */
export interface Connector {
  /** as Claude Code lists it, e.g. "claude.ai Gmail", "plugin:design:slack" */
  name: string
  /** what its tools are called: mcp__<name>__<tool>; the unit turned on or off */
  prefix: string
  source: 'claude.ai' | 'plugin' | 'user'
  /** "design" for plugin:design:slack */
  plugin?: string
  /** the server it talks to (host only) */
  host?: string
  status: 'connected' | 'needs-auth' | 'failed' | 'not-configured' | 'unknown'
  /** why it failed, when it did */
  detail?: string
}

/** One tool of a connector, as the connector describes it. */
export interface ConnectorTool {
  name: string
  /** only reads (the connector says so, or its name does when it doesn't say); otherwise it sends, creates, edits or deletes */
  readOnly: boolean
  /** may delete or overwrite */
  destructive?: boolean
}

/** A human decision for a LiveFollowUp. */
export type FollowUpDecision =
  | { type: 'allow'; always?: boolean; note?: string; hire?: HireEdits }
  | { type: 'deny'; note?: string }
  | { type: 'answer'; answers: Record<string, string | string[]> }
  /** Plans: pick one of the dialog's own options by its label (see LiveFollowUp.input.options). */
  | { type: 'plan'; option: string; feedback?: string }

/** Shared work data kept on the server in live mode. */
/** Boss mode: the manager delegates and messages agents without the owner's approval, until `until`. */
export interface BossMode {
  since: number
  until: number
}

/** Public access: the dashboard also on the open internet until `until` (a server on a domain on the tailnet). */
export interface PublicAccess {
  /** can be switched on this server (setup-vps.sh --tailscale --domain … --dns cloudflare) */
  supported: boolean
  domain?: string
  public: boolean
  since?: number
  until?: number
}

/** The owner's own note (Reports → Notes): rich text written in the dashboard, never given to the agents. */
export interface OwnerNoteSummary {
  id: string
  title: string
  /** the start of its text, plain (for lists and search) */
  excerpt: string
  projectId?: string
  tags?: string[]
  createdAt: number
  updatedAt: number
}
export interface OwnerNote extends Omit<OwnerNoteSummary, 'excerpt'> {
  /** TipTap's HTML */
  html: string
}

export interface WorkState {
  tasks: OfficeTask[]
  projects: Project[]
  crons: CronJob[]
  /** Office timezone the server schedules crons in. */
  timezone: string
  /** Prompts waiting for a busy agent, per agent id. */
  queued: Record<string, number>
  /** Newest first (the latest 200). */
  reports: WorkReport[]
  /** Done tasks old enough to be archived: not in `tasks`, fetched on demand from /api/tasks/archive. */
  archivedTasks: number
  settings: OfficeSettings
  automation: AutomationStatus
  /** the owner's tags (for tasks and reports) */
  tags: Tag[]
  /** on (until when), or null */
  bossMode: BossMode | null
  publicAccess: PublicAccess
  /** the owner's notes, newest first (without their text: GET /api/notes/:id) */
  notes: OwnerNoteSummary[]
}

/** An archived task, with when it was last touched (≈ when it was finished). */
export type ArchivedTask = OfficeTask & { updatedAt: number }

export interface TaskArchivePage {
  tasks: ArchivedTask[]
  total: number
  /** days a done task stays in the dashboards before it's archived */
  archiveDays: number
}

/** What an agent reported when it finished a task or a cron run: its final message of that turn. */
export interface WorkReport {
  id: string
  /** task / cron run: an agent's final message; note: something the manager wanted you to see */
  /** `chat`: an agent's answer to the owner's chat message sent with a project or tags (refId: the agent) */
  kind: 'task' | 'cron' | 'note' | 'chat'
  /** Task or cron job id */
  refId: string
  title: string
  agentId: string
  /** The agent's final message (markdown) */
  text: string
  ok: boolean
  startedAt: number
  finishedAt: number
  read: boolean
  /** files the agent wrote during this run, or pointed to in its report (downloadable) */
  files?: Attachment[]
  /** the project it's about: a task's project, or the one the manager filed its summary under */
  projectId?: string | null
  /** tag ids (a task's report starts with the task's tags) */
  tags?: string[]
}

export type OfficeEvent =
  | { type: 'activity'; entry: ActivityEntry }
  | { type: 'snapshot'; agents: AgentInfo[]; followUps: LiveFollowUp[]; rateLimits: RateLimits | null; work: WorkState }
  | { type: 'work'; work: Partial<WorkState> }
  | { type: 'agent'; agent: AgentInfo }
  | { type: 'remove'; id: string }
  | { type: 'followup'; followUp: LiveFollowUp }
  | { type: 'followup-resolved'; id: string }
  | { type: 'rate-limits'; rateLimits: RateLimits }
  | { type: 'usage'; date: string; agentId: string; input: number; output: number }
  /** a new entry in a task's timeline */
  | { type: 'comment'; comment: TaskComment }
  | { type: 'comment-removed'; id: string; taskId: string }
  /** the manager just handed `to` a task (drives a short "briefing" marker in the office) */
  | { type: 'briefing'; from: string; to: string; title: string }

/** One entry of an agent's conversation, simplified from the Claude Code transcript. */
export type ChatItem =
  | { kind: 'user'; id: string; at: number; text: string }
  | { kind: 'assistant'; id: string; at: number; text: string; model?: string }
  | { kind: 'tool'; id: string; at: number; tool: string; summary: string; input: unknown }
  | { kind: 'tool-result'; id: string; at: number; toolUseId: string; ok: boolean; text: string }

/**
 * A recurring job: on each selected weekday, at each of `times` (HH:MM in the office timezone), send `prompt`
 * to an agent.
 */
export interface CronJob {
  id: string
  name: string
  prompt: string
  /** One or more HH:MM times per day, sorted. */
  times: string[]
  /** Weekdays it runs on, 0 = Sunday … 6 = Saturday. */
  days: number[]
  agentId: string | null
  enabled: boolean
  /** Slots already fired, as "YYYY-MM-DD HH:MM" (office timezone), so each time runs once per day. */
  lastRuns?: string[]
  /** Start each run with /clear so the agent begins from a fresh context. */
  fresh?: boolean
  /** Server-owned: a webhook URL can run it (the token itself is never sent to the dashboard in lists). */
  trigger?: boolean
}

export type TaskPriority = 'low' | 'medium' | 'high'
export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done'

/** A coloured label the owner puts on tasks and reports (and filters by). */
export interface Tag {
  id: string
  name: string
  color: string
}

export interface Project {
  id: string
  name: string
  color: string
  /** Live: goal, repo/folder, conventions. Added to the prompt of every task in this project. */
  brief?: string
  /** Live: quality gate. Shell command run when an agent finishes a task (e.g. `bun test`), in the project's folder. */
  check?: string
  /** Live: the project's folder (absolute). Tasks are told to work there; checks and the Changes view run there. */
  folder?: string
}

export interface OfficeTask {
  /** who asked for it (the activity log's "why"): the owner from a device, or the manager and what started its turn */
  origin?: ActivityOrigin
  /** when it was made (ms; set by the server) */
  createdAt?: number
  id: string
  title: string
  agentId: string | null
  projectId: string | null
  /** epoch ms */
  deadline: number
  priority: TaskPriority
  status: TaskStatus
  description?: string
  /** When it was last handed to an agent (live mode). */
  startedAt?: number
  /** Live: hand it to the agent without clicking Start: at `startAt`, or as soon as the agent is free. */
  autoStart?: boolean
  /** epoch ms; only with autoStart. The deadline is when it must be done, this is when to begin. */
  startAt?: number
  /** Permission mode to switch the agent to for this task (e.g. 'auto' so it doesn't stop to ask).
   *  Unset: the agent's current mode. The previous mode is restored when the agent finishes. */
  mode?: LiveMode
  /** Server-owned: when the automatic start fired, so it fires once. */
  autoStartedAt?: number
  /** Server-owned: the manager agent that created this task (its report is forwarded to the manager). */
  delegatedBy?: string
  /** Live: task ids this one waits for. It starts on its own once all of them are finished (review or done). */
  blockedBy?: string[]
  /** tag ids (the owner's labels, see Tag) */
  tags?: string[]
  /** Live: quality gate for this task only (overrides the project's check). */
  check?: string
  /** Server-owned: quality gate state for the current run. */
  checkState?: 'running' | 'passed' | 'failed'
  /** Server-owned: automatic fix rounds after a failed check. */
  checkAttempts?: number
  /** Server-owned: the manager created it while approval is on; waits for the owner. */
  awaitingApproval?: boolean
  /** Server-owned: where the agent's repo stood when the task was handed over (for the Changes view). */
  gitBase?: { ref: string; untracked: string[]; at: number }
  /** Server-owned: when the owner was told this task looks stuck. */
  stuckNotifiedAt?: number
  /** Server-owned: a quality check command the manager proposed, waiting for the owner's approval. */
  pendingCheck?: string
  /** Server-owned: when the manager was asked to find someone for it (auto-assign). */
  assignAskedAt?: number
}

/** A file changed since a task was handed to its agent. */
export interface DiffFile {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  /** unified diff of this file (may be cut short) */
  patch: string
}

export interface TaskDiff {
  /** null: the agent's folder is not a git repo, or the task never started there */
  files: DiffFile[] | null
  truncated: boolean
  reason?: string
}

/** One entry in a task's timeline: a note from you, a revision request, an agent's report, the manager, the office. */
export interface TaskComment {
  id: string
  taskId: string
  author: 'user' | 'agent' | 'manager' | 'system'
  /** the agent (or manager) who wrote it */
  agentId?: string
  /** what kind of entry: a plain note, a revision request, a finished-work report */
  kind?: 'note' | 'revision' | 'report'
  text: string
  createdAt: number
  /** report entries: whether the run finished */
  ok?: boolean
}

/** Things that can be pushed to your phone (ntfy / Telegram / webhook, configured on the server). */
export type NotifyEvent = 'permission' | 'review' | 'cronFailed' | 'managerNote' | 'quota' | 'stuck' | 'security'

export interface OfficeSettings {
  /** which events are pushed */
  notify: Record<NotifyEvent, boolean>
  /** minimal: only what happened (no commands, no report text leave the server); full: include the details */
  notifyDetail: 'minimal' | 'full'
  /** Quota brake: at `threshold`% of the 5-hour or weekly plan limit, automatic work (auto-start, cron, manager
   *  delegation) waits until usage drops. Manual work always runs. */
  quota: { enabled: boolean; threshold: number }
  /** the manager's new tasks wait in "Needs your attention" until you approve them */
  managerApproval: boolean
  /** auto-start tasks without an agent are handed out (by the manager if there is one, else to an idle agent) */
  autoAssign: boolean
}

/** Read-only server state shown next to the settings. */
export interface AutomationStatus {
  /** notification channels configured in the server's .env */
  channels: string[]
  /** why automatic work is paused right now, or null */
  quotaPaused: string | null
}

/** Something a human has to look at: a permission prompt, a question, or finished work to review. */
export interface FollowUp {
  id: string
  agentId: string
  /** `plan` = an agent in plan mode waiting for its plan to be approved; `delegation` = a task from the manager. */
  kind: 'permission' | 'question' | 'review' | 'plan' | 'delegation' | 'hire' | 'check' | 'daily'
  message: string
  createdAt: number
  /** Long body shown in the detail view: the full plan, question context, review notes… */
  detail?: string
  /** For permission prompts: the tool and the exact command/input it wants to run. */
  tool?: string
  command?: string
}

export interface SystemMetrics {
  cpu: number
  memUsedGb: number
  memTotalGb: number
}

/** Tokens used by one agent on one day (YYYY-MM-DD). */
export interface TokenUsage {
  date: string
  agentId: string
  input: number
  output: number
}

/** GET /api/fs response: sub-directories of `path` (absolute), which lives under `root`. */
export interface DirListing {
  root: string
  path: string
  /** `path` relative to `root` ('' at the root). */
  relative: string
  dirs: string[]
  /** Every folder agents may live under */
  roots: string[]
  /** Where the picker starts (the agents' folder by default) */
  defaultDir: string
  /** Where new agents live: <agentsDir>/<name> */
  agentsDir: string
}

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

/** One Claude Code skill: written to `<cwd>/.claude/skills/<name>/SKILL.md`. */
export interface AgentSkill {
  id: string
  name: string
  description: string
  body: string
  enabled: boolean
}

/**
 * How an agent is set up. Phase 2: the server writes `claudeMd` to `<cwd>/CLAUDE.md`, skills to
 * `.claude/skills/`, and starts `claude --model <model> --permission-mode <mode>` in the agent's tmux session.
 */
export interface AgentProfile {
  role: string
  model: string
  permissionMode: PermissionMode
  claudeMd: string
  skills: AgentSkill[]
}

/** The office's default manager: a general manager over every division (divisions = the agents' roles). */
export const DEFAULT_MANAGER = {
  name: 'Marcus',
  role: 'General Manager',
  cwd: '~/after-office/marcus',
  model: 'opus',
} as const

/** An agent's division: its role, or "General" when it has none. */
export const divisionOf = (role?: string | null) => role?.trim() || 'General'

/** A file an agent made or pointed to, that the dashboard can show and download. */
export interface Attachment {
  /** absolute path on the server */
  path: string
  size: number
  /** a picture the browser can preview */
  image?: boolean
  /** gone since it was attached (deleted, or its folder removed) */
  missing?: boolean
}

/**
 * File paths mentioned in an agent's text: absolute (/…), home (~/…), and relative ones in `backticks` that look like a
 * file (have an extension). The server checks which really exist and may be shown.
 */
export function mentionedPaths(text: string): string[] {
  const out = new Set<string>()
  const clean = (p: string) => p.replace(/[.,;:)\]'"]+$/, '')
  for (const m of text.matchAll(/(?:^|[\s(`'"*])((?:~|\/)[\w.@~+%-]*(?:\/[\w.@~+%-]+)+\.[A-Za-z0-9]{1,8})(?=$|[\s)`'",;:.!?*])/gm)) out.add(clean(m[1]))
  for (const m of text.matchAll(/`([\w.@+-]+(?:\/[\w.@+-]+)*\.[A-Za-z0-9]{1,8})`/g)) out.add(clean(m[1]))
  return [...out].slice(0, 30)
}

/** A skill every agent already has from the Claude account's config folder (read-only in the dashboard). */
export interface AccountSkill {
  id: string
  name: string
  description: string
  /** user: your own skills folder; claude.ai: synced from your claude.ai account; plugin: part of a plugin */
  source: 'user' | 'claude.ai' | 'plugin'
  plugin?: string
}

/** A signed-in browser (Profile). `id` is the session's server-side key (a hash, not the cookie). */
export interface SessionInfo {
  id: string
  createdAt: number
  lastSeenAt: number
  expiresAt: number
  ip: string
  agent: string
  current: boolean
}

/** One sign-in attempt (Profile → recent sign-ins). */
export interface LoginEvent {
  at: number
  ok: boolean
  ip: string
  agent: string
  /** the username that was tried, when it wasn't the owner's */
  username?: string
  /** how far it got: the password, the authenticator code, or a recovery code (older entries: unknown) */
  step?: 'password' | 'code' | 'recovery'
}

/** Git state of a folder (the Projects tab). */
export interface GitInfo {
  branch: string | null
  /** changed or new files */
  dirty: number
  lastCommit: { subject: string; at: number } | null
}

export interface WorkspaceFolder {
  path: string
  /** the dashboard project linked to this folder, if any */
  projectId?: string | null
  name: string
  /** null: not a git repo */
  git: GitInfo | null
  /** last modification of the folder itself (ms) */
  updatedAt: number
}

/** An agent working folder, with the agents in it and (unless it is itself a project) the projects inside it. */
export interface Workspace extends WorkspaceFolder {
  agentIds: string[]
  /** the dashboard project linked to this folder, if any */
  projectId?: string | null
  /** the folder itself is one project (a repo, or it has package.json, README.md, …) */
  isProject: boolean
  projects: WorkspaceFolder[]
  /** the office's own projects folder (<agents dir>/project): new projects' folders, no agent lives here */
  shared?: boolean
  /** a folder in the agents' folder whose agent was removed (its files are still there) */
  orphan?: boolean
}

/** One entry of a folder in the Projects tab's file manager. */
export interface FolderEntry {
  name: string
  dir: boolean
  size: number
  updatedAt: number
  /** a symlink: listed, never followed */
  link?: boolean
  image?: boolean
}

export interface FolderListing {
  /** the folder the listing is inside of (an agent's folder, a project in one, or a project folder) */
  root: string
  /** relative to root; '' is root itself */
  path: string
  entries: FolderEntry[]
  /** entries left out past the limit */
  more: number
}

export interface GitCommit {
  hash: string
  subject: string
  author: string
  at: number
}

/** "Chrome on macOS" and a device kind, from a user agent (good enough to recognise your own devices). */
export function describeUserAgent(ua: string): { label: string; kind: 'phone' | 'tablet' | 'desktop' } {
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Unknown system'
  const browser = /Claude\//.test(ua)
    ? 'Claude app'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\//.test(ua)
        ? 'Opera'
        : /Firefox\/|FxiOS/.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS/.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : /curl|bun|node|python/i.test(ua)
                ? 'Script'
                : 'Browser'
  const kind = /iPad|Tablet/.test(ua) ? 'tablet' : /Mobile|iPhone|Android/.test(ua) ? 'phone' : 'desktop'
  return { label: ua ? `${browser} on ${os}` : 'Unknown device', kind }
}


// ── connector activity log ──

/** What started an agent's turn, followed back to a person or a trigger. */
export interface ActivityOrigin {
  kind: 'owner' | 'task' | 'cron' | 'webhook' | 'manager' | 'report' | 'agent'
  /** "Your chat", a task's title, a daily job's name, the manager's name… */
  label: string
  /** the owner's device ("Chrome on macOS"), for kind owner */
  device?: string
  /** the owner's (or a webhook caller's) IP address */
  ip?: string
  at?: number
  /** the manager worked in Boss mode (no approvals) */
  boss?: boolean
  /** one step further back (a task → who made it; the manager → what started its turn) */
  via?: ActivityOrigin
}

/** One thing an agent did with a connector (or something about the log itself, kind 'system'). */
export interface ActivityEntry {
  id: string
  at: number
  agentId: string
  agentName: string
  kind: 'tool' | 'system'
  /** "Gmail", "Google Drive"… */
  connector?: string
  tool?: string
  access?: 'read' | 'write'
  /** what it was called with: shortened, secrets masked */
  input?: string
  /** the start of what came back (or the error) */
  result?: string
  status: 'running' | 'waiting' | 'ok' | 'error' | 'denied' | 'info'
  /** who let it run: on its own (Read / Write on), or the owner answering a prompt */
  decision?: { by: 'auto' | 'owner'; allowed: boolean; at: number; device?: string; ip?: string }
  origin?: ActivityOrigin
  /** before a write: what it read in the same turn (pages, searches, connector reads), newest last */
  readBefore?: string[]
  /** kind 'system': what happened */
  message?: string
  /** when it finished */
  doneAt?: number
}

export interface ActivityPage {
  entries: ActivityEntry[]
  /** pass as `before` for the next (older) page; null when there's no more */
  next: number | null
}
