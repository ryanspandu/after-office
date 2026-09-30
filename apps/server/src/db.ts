import { Database } from 'bun:sqlite'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ActivityEntry, AgentKind, CronJob, LiveMode, OfficeTask, Project, TaskComment, WorkReport } from '@after-office/shared'

// Persistent state lives in one SQLite file (OFFICE_DATA_DIR, default apps/server/data).
// Runtime state (status, current tool, pending approvals) stays in memory and is rebuilt from hooks.

export const DATA_DIR = resolve(process.env.OFFICE_DATA_DIR ?? resolve(import.meta.dir, '../data'))
mkdirSync(DATA_DIR, { recursive: true })
// prompts, reports, sessions: for this user's eyes only
chmodSync(DATA_DIR, 0o700)

export const db = new Database(resolve(DATA_DIR, 'after-office.db'), { create: true })
for (const f of ['after-office.db', 'after-office.db-wal', 'after-office.db-shm']) if (existsSync(resolve(DATA_DIR, f))) chmodSync(resolve(DATA_DIR, f), 0o600)
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  tmux_session    TEXT NOT NULL UNIQUE,
  cwd             TEXT NOT NULL,
  desk            INTEGER NOT NULL,
  role            TEXT NOT NULL DEFAULT '',
  model           TEXT NOT NULL,
  permission_mode TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_daily (
  date     TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  input    INTEGER NOT NULL DEFAULT 0,
  output   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, agent_id)
);
CREATE TABLE IF NOT EXISTS projects (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  color TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  data        TEXT NOT NULL,        -- OfficeTask JSON
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS crons (
  id          TEXT PRIMARY KEY,
  data        TEXT NOT NULL,        -- CronJob JSON
  updated_at  INTEGER NOT NULL
);
-- prompts waiting for a busy agent to become idle (cron slots, task starts)
CREATE TABLE IF NOT EXISTS prompt_queue (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  text       TEXT NOT NULL,
  clear_first INTEGER NOT NULL DEFAULT 0,
  task_id    TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  data        TEXT NOT NULL,        -- WorkReport JSON
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- an agent's extra git identities (its default one is on the agent): used for the projects their rules match
CREATE TABLE IF NOT EXISTS git_identities (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  data       TEXT NOT NULL, -- GitIdentityRow JSON
  created_at INTEGER NOT NULL
);
-- how far each transcript has been read, so usage isn't counted twice after a restart
CREATE TABLE IF NOT EXISTS transcript_offsets (
  path   TEXT PRIMARY KEY,
  offset INTEGER NOT NULL
);
`)

// columns added after the first release
const hasColumn = (table: string, col: string) => db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)
if (!hasColumn('prompt_queue', 'cron_id')) db.exec('ALTER TABLE prompt_queue ADD COLUMN cron_id TEXT')
if (!hasColumn('agents', 'kind')) db.exec("ALTER TABLE agents ADD COLUMN kind TEXT NOT NULL DEFAULT 'worker'")
if (!hasColumn('agents', 'figure')) db.exec('ALTER TABLE agents ADD COLUMN figure TEXT')
// connectors an agent may use: JSON array of tool prefixes; NULL = every one (agents from before this)
if (!hasColumn('agents', 'connectors')) db.exec('ALTER TABLE agents ADD COLUMN connectors TEXT')
// a random number the dashboards draw its character from (hair, hat, glasses…); NULL: drawn from the desk
if (!hasColumn('agents', 'style')) db.exec('ALTER TABLE agents ADD COLUMN style INTEGER')
// thinking effort (`claude --effort`); NULL: Claude Code's default. The manager starts on high: it plans and checks
// everyone's work (used from its next session start).
if (!hasColumn('agents', 'effort')) {
  db.exec('ALTER TABLE agents ADD COLUMN effort TEXT')
  db.exec("UPDATE agents SET effort = 'high' WHERE kind = 'manager'")
}
// connectors it may also write with (send, create, edit, delete…); the rest are read-only (their writes need the owner)
if (!hasColumn('agents', 'connectors_write')) db.exec('ALTER TABLE agents ADD COLUMN connectors_write TEXT')
// connectors whose reading also waits for the owner (Read turned off in the Connectors tab)
if (!hasColumn('agents', 'connectors_read_ask')) db.exec('ALTER TABLE agents ADD COLUMN connectors_read_ask TEXT')
// per-agent git identity and SSH key (the key itself is a file in the agents' home; these are its public half)
for (const col of ['git_name', 'git_email', 'ssh_public', 'ssh_fingerprint']) if (!hasColumn('agents', col)) db.exec(`ALTER TABLE agents ADD COLUMN ${col} TEXT`)
if (!hasColumn('agents', 'pinned')) db.exec('ALTER TABLE agents ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')
if (!hasColumn('agents', 'extra_dirs')) db.exec("ALTER TABLE agents ADD COLUMN extra_dirs TEXT NOT NULL DEFAULT '[]'")
db.exec('CREATE INDEX IF NOT EXISTS tasks_updated ON tasks (updated_at)')
if (!hasColumn('projects', 'brief')) db.exec('ALTER TABLE projects ADD COLUMN brief TEXT')
if (!hasColumn('projects', 'check_cmd')) db.exec('ALTER TABLE projects ADD COLUMN check_cmd TEXT')
if (!hasColumn('projects', 'folder')) db.exec('ALTER TABLE projects ADD COLUMN folder TEXT')
// webhook tokens that can run a cron job (never part of the dashboard's work state)
db.exec('CREATE TABLE IF NOT EXISTS cron_triggers (cron_id TEXT PRIMARY KEY, token TEXT NOT NULL, last_at INTEGER NOT NULL DEFAULT 0)')
// a task's timeline (TaskComment JSON); newer tables are created here so old databases get them too
db.exec(`
-- signed-in browsers (the cookie holds a random id; only its SHA-256 is stored)
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user        TEXT NOT NULL,
  pw          TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  ip          TEXT NOT NULL DEFAULT '',
  agent       TEXT NOT NULL DEFAULT ''
);
-- sign-in attempts, newest kept (Profile → recent sign-ins)
CREATE TABLE IF NOT EXISTS login_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  ok     INTEGER NOT NULL,
  ip     TEXT NOT NULL,
  agent  TEXT NOT NULL,
  user   TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS task_comments (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  data        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_comments_task ON task_comments (task_id, created_at);
-- what agents did with connectors (the Activity log): one JSON entry per tool call, kept 90 days
CREATE TABLE IF NOT EXISTS activity_log (
  id        TEXT PRIMARY KEY,
  at        INTEGER NOT NULL,
  agent_id  TEXT NOT NULL,
  data      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_log_at ON activity_log (at);
CREATE INDEX IF NOT EXISTS activity_log_agent ON activity_log (agent_id, at);
`)
if (!hasColumn('sessions', 'last_seen')) db.exec('ALTER TABLE sessions ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0')
// which step of signing in an entry is about: the password, the authenticator code, or a recovery code
if (!hasColumn('login_log', 'step')) db.exec("ALTER TABLE login_log ADD COLUMN step TEXT NOT NULL DEFAULT ''")
// signed in with the authenticator code too (2FA); a session without it may only set 2FA up
if (!hasColumn('sessions', 'mfa')) db.exec('ALTER TABLE sessions ADD COLUMN mfa INTEGER NOT NULL DEFAULT 0')

export interface AgentRow {
  id: string
  name: string
  tmux_session: string
  cwd: string
  desk: number
  role: string
  model: string
  permission_mode: LiveMode
  session_id: string
  created_at: number
  kind: AgentKind
  /** JSON array of project folders outside `cwd` the agent may work in */
  extra_dirs?: string
  /** 'man' | 'woman': its character in the office */
  figure?: string | null
  /** JSON array of the connectors (tool prefixes) it may use; null = every one */
  connectors?: string | null
  /** 1: pinned to the top of the agents list */
  pinned?: number
  /** its character's look (random at creation; the dashboard draws hair, hat, glasses… from it) */
  style?: number | null
  /** 'low' … 'max' (`claude --effort`); null: Claude Code's default */
  effort?: string | null
  /** JSON array of the connectors (tool prefixes) it may write with; the others are read-only */
  connectors_write?: string | null
  /** JSON array of the connectors whose reading also asks the owner first (Read off) */
  connectors_read_ask?: string | null
  /** name and email its commits carry */
  git_name?: string | null
  git_email?: string | null
  /** its SSH key's public half and fingerprint (the private key is a file only the agents' user reads) */
  ssh_public?: string | null
  ssh_fingerprint?: string | null
}

/** The connectors (tool prefixes) an agent may use; null: every one (it was set up before connectors were managed). */
/** Connectors this agent may write with (the others are read-only: their writes wait for the owner). */
export const connectorsWriteOf = (row: Pick<AgentRow, 'connectors_write'>) => stringList(row.connectors_write)
/** Connectors whose reading also waits for the owner (Read turned off). */
export const connectorsReadAskOf = (row: Pick<AgentRow, 'connectors_read_ask'>) => stringList(row.connectors_read_ask)

function stringList(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function connectorsOf(row: Pick<AgentRow, 'connectors'>): string[] | null {
  if (row.connectors === null || row.connectors === undefined) return null
  try {
    const v = JSON.parse(row.connectors)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** An agent's extra project folders (never throws on a bad value). */
export const extraDirsOf = (row: Pick<AgentRow, 'extra_dirs'> | null | undefined): string[] => {
  try {
    const v = JSON.parse(row?.extra_dirs || '[]')
    return Array.isArray(v) ? v.filter((d) => typeof d === 'string') : []
  } catch {
    return []
  }
}

export const agentsRepo = {
  all: () => db.query<AgentRow, []>('SELECT * FROM agents ORDER BY desk').all(),
  get: (id: string) => db.query<AgentRow, [string]>('SELECT * FROM agents WHERE id = ?').get(id),
  insert: (a: AgentRow) =>
    db
      .query(
        `INSERT INTO agents (id, name, tmux_session, cwd, desk, role, model, permission_mode, session_id, created_at, kind, figure, connectors, style, effort)
         VALUES ($id, $name, $tmux_session, $cwd, $desk, $role, $model, $permission_mode, $session_id, $created_at, $kind, $figure, $connectors, $style, $effort)`,
      )
      .run({
        $id: a.id,
        $name: a.name,
        $tmux_session: a.tmux_session,
        $cwd: a.cwd,
        $desk: a.desk,
        $role: a.role,
        $model: a.model,
        $permission_mode: a.permission_mode,
        $session_id: a.session_id,
        $created_at: a.created_at,
        $kind: a.kind,
        $figure: a.figure ?? null,
        $connectors: a.connectors ?? null,
        $style: a.style ?? null,
        $effort: a.effort ?? null,
      }),
  update: (id: string, patch: Partial<Pick<AgentRow, 'model' | 'permission_mode' | 'session_id' | 'name' | 'role' | 'cwd' | 'extra_dirs' | 'figure' | 'connectors' | 'pinned' | 'style' | 'effort' | 'git_name' | 'git_email' | 'ssh_public' | 'ssh_fingerprint' | 'connectors_write' | 'connectors_read_ask'>>) => {
    const keys = Object.keys(patch) as (keyof typeof patch)[]
    if (!keys.length) return
    db.query(`UPDATE agents SET ${keys.map((k) => `${k} = $${k}`).join(', ')} WHERE id = $id`).run({
      $id: id,
      ...Object.fromEntries(keys.map((k) => [`$${k}`, patch[k] as string])),
    })
  },
  remove: (id: string) => db.query('DELETE FROM agents WHERE id = ?').run(id),
  manager: () => db.query<AgentRow, []>(`SELECT * FROM agents WHERE kind = 'manager' LIMIT 1`).get(),
  /** Lowest desk index not taken by another agent. */
  freeDesk: () => {
    const used = new Set(db.query<{ desk: number }, []>('SELECT desk FROM agents').all().map((r) => r.desk))
    let d = 0
    while (used.has(d)) d++
    return d
  },
}

export const usageRepo = {
  add: (date: string, agentId: string, input: number, output: number) =>
    db
      .query(
        `INSERT INTO usage_daily (date, agent_id, input, output) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(date, agent_id) DO UPDATE SET input = input + ?3, output = output + ?4`,
      )
      .run(date, agentId, input, output),
  range: (from: string, to: string) =>
    db
      .query<{ date: string; agent_id: string; input: number; output: number }, [string, string]>(
        'SELECT * FROM usage_daily WHERE date BETWEEN ?1 AND ?2 ORDER BY date',
      )
      .all(from, to),
}

export const offsetsRepo = {
  get: (path: string) => db.query<{ offset: number }, [string]>('SELECT offset FROM transcript_offsets WHERE path = ?').get(path)?.offset ?? 0,
  set: (path: string, offset: number) =>
    db.query('INSERT INTO transcript_offsets (path, offset) VALUES (?1, ?2) ON CONFLICT(path) DO UPDATE SET offset = ?2').run(path, offset),
}

/** JSON-document tables (tasks, crons): the shape lives in @after-office/shared, SQLite just stores it. */
function docRepo<T extends { id: string }>(table: 'tasks' | 'crons' | 'reports') {
  return {
    all: () => db.query<{ data: string }, []>(`SELECT data FROM ${table} ORDER BY updated_at`).all().map((r) => JSON.parse(r.data) as T),
    get: (id: string) => {
      const r = db.query<{ data: string }, [string]>(`SELECT data FROM ${table} WHERE id = ?`).get(id)
      return r ? (JSON.parse(r.data) as T) : null
    },
    put: (doc: T) =>
      db
        .query(`INSERT INTO ${table} (id, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET data = ?2, updated_at = ?3`)
        .run(doc.id, JSON.stringify(doc), Date.now()),
    remove: (id: string) => db.query(`DELETE FROM ${table} WHERE id = ?`).run(id),
    count: () => db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,
  }
}

/** Done tasks untouched for this many days are archived: kept in the DB, but no longer sent to every dashboard. */
export const ARCHIVE_DAYS = Math.max(1, Number(process.env.OFFICE_ARCHIVE_DAYS) || 30)
const archiveCutoff = () => Date.now() - ARCHIVE_DAYS * 86_400_000
const ARCHIVED = `json_extract(data, '$.status') = 'done' AND updated_at < ?1`

export const tasksRepo = {
  ...docRepo<OfficeTask>('tasks'),
  /** Everything the dashboards work with: all tasks except the archived ones. */
  active: () =>
    db
      .query<{ data: string }, [number]>(`SELECT data FROM tasks WHERE NOT (${ARCHIVED}) ORDER BY updated_at`)
      .all(archiveCutoff())
      .map((r) => JSON.parse(r.data) as OfficeTask),
  archivedCount: () => db.query<{ n: number }, [number]>(`SELECT COUNT(*) AS n FROM tasks WHERE ${ARCHIVED}`).get(archiveCutoff())!.n,
  /** Archived tasks, most recently finished first, optionally filtered by a title search. */
  archived: ({ q = '', offset = 0, limit = 50 }: { q?: string; offset?: number; limit?: number } = {}) => {
    const where = `${ARCHIVED} AND instr(lower(json_extract(data, '$.title')), lower(?2)) > 0`
    const args = [archiveCutoff(), q.trim()] as const
    const total = db.query<{ n: number }, [number, string]>(`SELECT COUNT(*) AS n FROM tasks WHERE ${where}`).get(...args)!.n
    const rows = db
      .query<{ data: string; updated_at: number }, [number, string, number, number]>(
        `SELECT data, updated_at FROM tasks WHERE ${where} ORDER BY updated_at DESC LIMIT ?3 OFFSET ?4`,
      )
      .all(...args, limit, offset)
    return { total, tasks: rows.map((r) => ({ ...(JSON.parse(r.data) as OfficeTask), updatedAt: r.updated_at })) }
  },
  /** Bring an archived task back into the dashboards (counts as touched now). */
  touch: (id: string) => db.query('UPDATE tasks SET updated_at = ?2 WHERE id = ?1').run(id, Date.now()).changes > 0,
}
export const cronsRepo = docRepo<CronJob>('crons')
const reportsDocs = docRepo<WorkReport>('reports')
export const reportsRepo = {
  ...reportsDocs,
  /** Newest first. */
  latest: (limit = 200) =>
    db.query<{ data: string }, [number]>(`SELECT data FROM reports ORDER BY json_extract(data, '$.finishedAt') DESC LIMIT ?`).all(limit).map((r) => JSON.parse(r.data) as WorkReport),
  /** Keep the table small: drop all but the newest `keep`. */
  prune: (keep = 1000) =>
    db.query(`DELETE FROM reports WHERE id NOT IN (SELECT id FROM reports ORDER BY json_extract(data, '$.finishedAt') DESC LIMIT ?)`).run(keep),
}

/** Longest timeline kept per task (oldest entries dropped first). */
const COMMENTS_PER_TASK = 200

export const commentsRepo = {
  /** Oldest first. */
  forTask: (taskId: string) =>
    db
      .query<{ data: string }, [string]>('SELECT data FROM task_comments WHERE task_id = ? ORDER BY created_at, rowid')
      .all(taskId)
      .map((r) => JSON.parse(r.data) as TaskComment),
  get: (id: string) => {
    const r = db.query<{ data: string }, [string]>('SELECT data FROM task_comments WHERE id = ?').get(id)
    return r ? (JSON.parse(r.data) as TaskComment) : null
  },
  add: (c: TaskComment) => {
    db.query('INSERT INTO task_comments (id, task_id, data, created_at) VALUES (?1, ?2, ?3, ?4)').run(c.id, c.taskId, JSON.stringify(c), c.createdAt)
    db.query(
      `DELETE FROM task_comments WHERE task_id = ?1 AND id NOT IN
         (SELECT id FROM task_comments WHERE task_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2)`,
    ).run(c.taskId, COMMENTS_PER_TASK)
  },
  remove: (id: string) => db.query('DELETE FROM task_comments WHERE id = ?').run(id),
  removeTask: (taskId: string) => db.query('DELETE FROM task_comments WHERE task_id = ?').run(taskId),
}

type ProjectRow = { id: string; name: string; color: string; brief: string | null; check_cmd: string | null; folder: string | null }
const toProject = (r: ProjectRow): Project => ({ id: r.id, name: r.name, color: r.color, ...(r.brief ? { brief: r.brief } : {}), ...(r.check_cmd ? { check: r.check_cmd } : {}), ...(r.folder ? { folder: r.folder } : {}) })

export interface SessionRow {
  id: string
  user: string
  pw: string
  expires_at: number
  created_at: number
  ip: string
  agent: string
  last_seen?: number
  /** 1: signed in with the authenticator code as well */
  mfa?: number
}

export const sessionsRepo = {
  get: (id: string) => db.query<SessionRow, [string]>('SELECT * FROM sessions WHERE id = ?').get(id),
  add: (r: SessionRow) => {
    db.query('DELETE FROM sessions WHERE expires_at < ?').run(Date.now())
    db.query('INSERT INTO sessions (id, user, pw, expires_at, created_at, ip, agent, last_seen, mfa) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)').run(
      r.id, r.user, r.pw, r.expires_at, r.created_at, r.ip, r.agent, r.last_seen ?? r.created_at, r.mfa ?? 0,
    )
  },
  remove: (id: string) => db.query('DELETE FROM sessions WHERE id = ?').run(id),
  clear: () => db.query('DELETE FROM sessions').run(),
  /** every live session but `keep` */
  clearOthers: (keep: string) => db.query('DELETE FROM sessions WHERE id != ?').run(keep),
  active: (user: string) =>
    db.query<SessionRow, [string, number]>('SELECT * FROM sessions WHERE user = ?1 AND expires_at > ?2 ORDER BY last_seen DESC').all(user, Date.now()),
  touch: (id: string, at: number) => db.query('UPDATE sessions SET last_seen = ?2 WHERE id = ?1').run(id, at),
  /** a session kept across a password change (the one that changed it) */
  setPw: (id: string, pw: string) => db.query('UPDATE sessions SET pw = ?2 WHERE id = ?1').run(id, pw),
  /** a session kept across a username change (the one that changed it) */
  setUser: (id: string, user: string) => db.query('UPDATE sessions SET user = ?2 WHERE id = ?1').run(id, user),
  /** this browser just proved the authenticator code (2FA set up here) */
  setMfa: (id: string) => db.query('UPDATE sessions SET mfa = 1 WHERE id = ?1').run(id),
}

const LOGIN_LOG_KEEP = 200
export const loginLog = {
  add: (e: { at: number; ok: boolean; ip: string; agent: string; user: string; step?: 'password' | 'code' | 'recovery' }) => {
    db.query('INSERT INTO login_log (at, ok, ip, agent, user, step) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').run(e.at, e.ok ? 1 : 0, e.ip, e.agent, e.user, e.step ?? '')
    db.query('DELETE FROM login_log WHERE id NOT IN (SELECT id FROM login_log ORDER BY id DESC LIMIT ?)').run(LOGIN_LOG_KEEP)
  },
  latest: (limit = 30) =>
    db.query<{ at: number; ok: number; ip: string; agent: string; user: string; step: string }, [number]>('SELECT at, ok, ip, agent, user, step FROM login_log ORDER BY id DESC LIMIT ?').all(limit),
}

export const projectsRepo = {
  all: () => db.query<ProjectRow, []>('SELECT * FROM projects ORDER BY rowid').all().map(toProject),
  get: (id: string) => {
    const r = db.query<ProjectRow, [string]>('SELECT * FROM projects WHERE id = ?').get(id)
    return r ? toProject(r) : null
  },
  put: (p: Project) =>
    db
      .query(
        `INSERT INTO projects (id, name, color, brief, check_cmd, folder) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET name = ?2, color = ?3, brief = ?4, check_cmd = ?5, folder = ?6`,
      )
      .run(p.id, p.name, p.color, p.brief ?? null, p.check ?? null, p.folder ?? null),
  remove: (id: string) => db.query('DELETE FROM projects WHERE id = ?').run(id),
}

/** Webhook tokens are stored as SHA-256 (the dashboard shows a token once, when it is made). */
export const hashTriggerToken = (token: string) => `sha256:${new Bun.CryptoHasher('sha256').update(token).digest('hex')}`
// tokens saved before they were hashed
for (const r of db.query<{ cron_id: string; token: string }, []>("SELECT cron_id, token FROM cron_triggers WHERE token NOT LIKE 'sha256:%'").all())
  db.query('UPDATE cron_triggers SET token = ?2 WHERE cron_id = ?1').run(r.cron_id, hashTriggerToken(r.token))

export const triggersRepo = {
  /** `token` is the stored hash */
  get: (cronId: string) => db.query<{ token: string; last_at: number }, [string]>('SELECT token, last_at FROM cron_triggers WHERE cron_id = ?').get(cronId),
  set: (cronId: string, token: string) =>
    db.query('INSERT INTO cron_triggers (cron_id, token) VALUES (?1, ?2) ON CONFLICT(cron_id) DO UPDATE SET token = ?2').run(cronId, hashTriggerToken(token)),
  touch: (cronId: string, at: number) => db.query('UPDATE cron_triggers SET last_at = ?2 WHERE cron_id = ?1').run(cronId, at),
  remove: (cronId: string) => db.query('DELETE FROM cron_triggers WHERE cron_id = ?').run(cronId),
  ids: () => new Set(db.query<{ cron_id: string }, []>('SELECT cron_id FROM cron_triggers').all().map((r) => r.cron_id)),
}

export interface QueuedPrompt {
  id: string
  agent_id: string
  text: string
  clear_first: number
  task_id: string | null
  cron_id: string | null
  created_at: number
}

export const queueRepo = {
  add: (q: Omit<QueuedPrompt, 'created_at'>) =>
    db
      .query('INSERT INTO prompt_queue (id, agent_id, text, clear_first, task_id, cron_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
      .run(q.id, q.agent_id, q.text, q.clear_first, q.task_id, q.cron_id, Date.now()),
  next: (agentId: string) =>
    db.query<QueuedPrompt, [string]>('SELECT * FROM prompt_queue WHERE agent_id = ? ORDER BY created_at LIMIT 1').get(agentId),
  remove: (id: string) => db.query('DELETE FROM prompt_queue WHERE id = ?').run(id),
  countFor: (agentId: string) => db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM prompt_queue WHERE agent_id = ?').get(agentId)!.n,
  removeAgent: (agentId: string) => db.query('DELETE FROM prompt_queue WHERE agent_id = ?').run(agentId),
  removeTask: (taskId: string) => db.query('DELETE FROM prompt_queue WHERE task_id = ?').run(taskId),
}

export interface GitIdentityRow {
  id: string
  agentId: string
  label: string
  name: string
  email: string
  /** where it applies: folders (/…, ~/…) or repos by remote (github.com/acme, git@host:org/**) */
  match: string[]
  sshPublic?: string
  sshFingerprint?: string
}

export const gitIdentitiesRepo = {
  forAgent: (agentId: string) =>
    db
      .query<{ data: string }, [string]>('SELECT data FROM git_identities WHERE agent_id = ? ORDER BY created_at')
      .all(agentId)
      .map((r) => JSON.parse(r.data) as GitIdentityRow),
  get: (id: string) => {
    const r = db.query<{ data: string }, [string]>('SELECT data FROM git_identities WHERE id = ?').get(id)
    return r ? (JSON.parse(r.data) as GitIdentityRow) : null
  },
  put: (g: GitIdentityRow) =>
    db
      .query('INSERT INTO git_identities (id, agent_id, data, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET data = ?3')
      .run(g.id, g.agentId, JSON.stringify(g), Date.now()),
  remove: (id: string) => db.query('DELETE FROM git_identities WHERE id = ?').run(id),
  removeAgent: (agentId: string) => db.query('DELETE FROM git_identities WHERE agent_id = ?').run(agentId),
}

export const settingsRepo = {
  get: (key: string) => db.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null,
  set: (key: string, value: string) =>
    db.query('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2').run(key, value),
  delete: (key: string) => db.query('DELETE FROM settings WHERE key = ?').run(key),
}

// ── the Activity log (work/activity.ts) ──
export interface ActivityFilter {
  agentId?: string
  connector?: string
  access?: 'read' | 'write'
  /** only what failed or was refused */
  problems?: boolean
  /** words anywhere in the entry (agent, connector, tool, input, result, origin) */
  q?: string
  from?: number
  to?: number
  /** entries older than this (paging) */
  before?: number
  limit?: number
}

export const activityRepo = {
  put: (e: ActivityEntry) =>
    db.query('INSERT INTO activity_log (id, at, agent_id, data) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET data = ?4').run(e.id, e.at, e.agentId, JSON.stringify(e)),
  get: (id: string) => {
    const r = db.query<{ data: string }, [string]>('SELECT data FROM activity_log WHERE id = ?').get(id)
    return r ? (JSON.parse(r.data) as ActivityEntry) : null
  },
  list: (f: ActivityFilter = {}) => {
    const where: string[] = []
    const args: Record<string, string | number> = {}
    if (f.agentId) (where.push('agent_id = $agent'), (args.$agent = f.agentId))
    if (f.connector) (where.push("json_extract(data, '$.connector') = $connector"), (args.$connector = f.connector))
    if (f.access) (where.push("json_extract(data, '$.access') = $access"), (args.$access = f.access))
    if (f.problems) where.push("json_extract(data, '$.status') IN ('error', 'denied')")
    ;(f.q ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6)
      .forEach((w, i) => {
        where.push(`data LIKE $q${i} ESCAPE '\\'`)
        args[`$q${i}`] = `%${w.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
      })
    if (f.from) (where.push('at >= $from'), (args.$from = f.from))
    if (f.to) (where.push('at <= $to'), (args.$to = f.to))
    if (f.before) (where.push('at < $before'), (args.$before = f.before))
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 5000)
    return db
      .query<{ data: string }, Record<string, string | number>>(`SELECT data FROM activity_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, rowid DESC LIMIT ${limit}`)
      .all(args)
      .map((r) => JSON.parse(r.data) as ActivityEntry)
  },
  /** the connectors that show up in the log (for the filter) */
  connectors: () =>
    db
      .query<{ c: string }, []>("SELECT DISTINCT json_extract(data, '$.connector') AS c FROM activity_log WHERE c IS NOT NULL ORDER BY c")
      .all()
      .map((r) => r.c),
  prune: (olderThan: number) => db.query('DELETE FROM activity_log WHERE at < ?').run(olderThan),
}
