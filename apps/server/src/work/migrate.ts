import { Database } from 'bun:sqlite'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, join, sep } from 'node:path'
import { agentsRepo, DATA_DIR, db, sideSessionsRepo } from '../db'
import { backupNow } from '../backup'
import { config } from '../auth'
import { seal, unseal } from '../totp'
import { AGENT_HOME, AGENTS_DIR, CLAUDE_PROJECTS_DIR, PROJECT_DIR, ROOTS } from '../fsroots'
import { runAsAgent } from '../agents/asagent'
import { tmux } from '../agents/tmux'
import { revivePause } from '../agents/reconciler'
import { AgentError } from '../agents/errors'

// Move a whole office to another server (Office settings → Move this office): export everything into one file, and
// import such a file here, replacing what's here.
//
// The file is a plain tar of:
//   manifest.json          where things were on the old server (to put paths right on the new one), what's inside
//   db.sqlite.gz           the database (a consistent copy: VACUUM INTO)
//   secrets.json           the values sealed with the old server's SESSION_SECRET (2FA secret, push key, notification
//                          tokens), opened and sealed again with the owner's passphrase (scrypt + AES-256-GCM)
//   data.tar.gz            the dashboard's own files (the owner's picture, the logo)
//   agents.tar.gz          the agents' folder (and the projects in it), if chosen; root-<n>.tar.gz: other agent roots
//   conv-<agent id>.tar.gz each agent's Claude Code conversations, if chosen
// Not in it: the agents' Claude login (an account token; sign in again on the new server), the server's .env (its own
// password hash and secrets), and bulky rebuildable folders (node_modules, virtualenvs, caches).
//
// Agent files are read and written as the agents' user (runAsAgent): on the hardened VPS the dashboard can't reach
// ~/.claude, and files it made would be the wrong owner. Importing restarts the server; the new database is put in
// place before it opens (db.ts, `import-pending.db`).

export const PENDING_DB = join(DATA_DIR, 'import-pending.db')
const WORK = join(DATA_DIR, 'migrate')
const EXPORTS = join(DATA_DIR, 'exports')
/** where agent-side archives are made and read (the agents' user can write here, the dashboard can read) */
const STAGE = join(AGENTS_DIR, '.migrate')
const FORMAT = 'after-office-export'
/** rebuildable and bulky: left out of agent folders */
const SKIP = ['node_modules', '.venv', 'venv', '__pycache__', '.cache', '.next', '.turbo', '.gradle']
const HOUR = 3_600_000
export const CHUNK = 8 * 1024 * 1024

interface Manifest {
  format: typeof FORMAT
  version: 1
  createdAt: number
  from: string
  agentHome: string
  agentsDir: string
  claudeProjectsDir: string
  /** other agent roots (the VPS's ~/projects), archived as root-<index>.tar.gz */
  roots: string[]
  folders: boolean
  /** agent id → its folder on the old server (its conversations are under a name made from it) */
  conversations: Record<string, string>
}

export interface MigrateJob {
  kind: 'export' | 'import'
  step: string
  done: boolean
  error?: string
  /** export: the file's size when it's ready */
  size?: number
  name?: string
  startedAt: number
  /** import: the server restarts in a moment */
  restarting?: boolean
}

/** This server's key for sealed values (SESSION_SECRET; read straight from the env when sign-in isn't fully set up). */
const serverSecret = () => {
  const s = config?.secret ?? process.env.SESSION_SECRET
  if (!s || s.length < 32) throw new AgentError('Sign-in is not set up on this server (SESSION_SECRET)', 500)
  return s
}
/** What happens once an import is in place (tests replace it): the server exits, its service manager starts it again. */
export const afterImport = { restart: (): void => process.exit(0) }

let job: MigrateJob | null = null
let exportFile: string | null = null
export const migrateStatus = () => job
export const exportPath = () => (exportFile && existsSync(exportFile) ? exportFile : null)

const busy = () => {
  if (job && !job.done) throw new AgentError(`An ${job.kind} is already running (${job.step})`, 409)
}
const stamp = () => new Date().toISOString().slice(0, 19).replace('T', '-').replaceAll(':', '')
const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
const convName = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-')
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** The agent roots worth moving besides AGENTS_DIR: inside the agents' home, not the home itself, not this checkout. */
function extraRoots() {
  return ROOTS.filter((r) => r !== AGENT_HOME && inside(r, AGENT_HOME) && !inside(r, AGENTS_DIR) && !inside(AGENTS_DIR, r) && !inside(PROJECT_DIR, r))
}

/** A command as the dashboard; GNU tar's 1 ("a file changed while read") is fine for a live folder. */
async function run(argv: string[], okCodes = [0]) {
  const p = Bun.spawn(argv, { stdout: 'ignore', stderr: 'pipe' })
  const err = await new Response(p.stderr).text()
  const code = await p.exited
  if (!okCodes.includes(code)) throw new Error(`${argv[0]} failed: ${err.trim().split('\n').slice(-2).join(' ') || `exit ${code}`}`)
}
/** A shell script as the agents' user (their files). */
async function asAgent(script: string, cwd = AGENTS_DIR, okCodes = [0]) {
  const r = await runAsAgent(['sh', '-c', script], { cwd, timeoutMs: 2 * HOUR, mergeStderr: true })
  if (r.timedOut) throw new Error('Timed out')
  if (!okCodes.includes(r.code)) throw new Error(r.out.trim().split('\n').slice(-2).join(' ') || `exit ${r.code}`)
  return r.out
}

// ── secrets: sealed with this server's key at rest; with the passphrase in the file ──

const SEALED = /v1:[A-Za-z0-9+/]{30,}={0,2}/g

/** Every text column of every table (for finding sealed values and moving paths). */
function textColumns(d: Database) {
  const tables = d.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
  return tables.flatMap(({ name }) =>
    d
      .query<{ name: string; type: string }, []>(`PRAGMA table_info("${name}")`)
      .all()
      .filter((c) => !c.type || /TEXT|CHAR|CLOB|JSON/i.test(c.type))
      .map((c) => ({ table: name, column: c.name })),
  )
}

function openedSecrets(d: Database, secret: string) {
  const out: Record<string, string> = {}
  for (const { table, column } of textColumns(d)) {
    const rows = d.query<{ v: string }, []>(`SELECT "${column}" AS v FROM "${table}" WHERE "${column}" LIKE '%v1:%'`).all()
    for (const { v } of rows)
      for (const m of String(v).match(SEALED) ?? []) {
        const plain = unseal(m, secret)
        if (plain !== null) out[m] = plain
      }
  }
  return out
}

const keyOf = (pass: string, salt: Buffer) => scryptSync(pass, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })

function lock(data: unknown, pass: string) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', keyOf(pass, salt), iv)
  const body = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()])
  return { v: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: body.toString('base64') }
}

function unlock(box: { salt: string; iv: string; tag: string; data: string }, pass: string): Record<string, string> {
  try {
    const d = createDecipheriv('aes-256-gcm', keyOf(pass, Buffer.from(box.salt, 'base64')), Buffer.from(box.iv, 'base64'))
    d.setAuthTag(Buffer.from(box.tag, 'base64'))
    return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'))
  } catch {
    throw new AgentError("That passphrase doesn't open this file", 400)
  }
}

function checkPassphrase(pass: unknown): string {
  if (typeof pass !== 'string' || pass.length < 8) throw new AgentError('The passphrase needs at least 8 characters', 400)
  if (pass.length > 200) throw new AgentError('Passphrase too long', 400)
  return pass
}

// ── export ──

export function startExport(opts: { passphrase: unknown; folders?: unknown; conversations?: unknown }) {
  busy()
  const secret = serverSecret()
  const pass = checkPassphrase(opts.passphrase)
  const id = stamp()
  job = { kind: 'export', step: 'Starting', done: false, startedAt: Date.now() }
  const current = job
  void (async () => {
    const work = join(WORK, `export-${id}`)
    const stage = join(STAGE, id)
    const step = (s: string) => (current.step = s)
    try {
      rmSync(WORK, { recursive: true, force: true })
      mkdirSync(work, { recursive: true, mode: 0o700 })
      // the database: a consistent copy, checked
      step('Copying the database')
      const copy = join(work, 'db.sqlite')
      db.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`)
      const check = new Database(copy, { readonly: true })
      const ok = check.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check === 'ok'
      const secrets = openedSecrets(check, secret)
      check.close()
      if (!ok) throw new Error('The database copy failed its integrity check')
      writeFileSync(join(work, 'db.sqlite.gz'), Bun.gzipSync(readFileSync(copy)))
      rmSync(copy)
      writeFileSync(join(work, 'secrets.json'), JSON.stringify(lock(secrets, pass)))
      // the dashboard's own files
      step('Packing the dashboard files')
      const own = ['profile', 'branding'].filter((d) => existsSync(join(DATA_DIR, d)))
      await run(['tar', '-czf', join(work, 'data.tar.gz'), '-C', DATA_DIR, ...(own.length ? own : ['--files-from', '/dev/null'])])

      const agentFiles: string[] = []
      const roots = opts.folders ? extraRoots() : []
      const conversations: Record<string, string> = {}
      if (opts.folders || opts.conversations) await asAgent(`mkdir -p ${q(stage)} && chmod 750 ${q(stage)}`)
      if (opts.folders) {
        step('Packing the agents’ folders')
        const skip = SKIP.flatMap((s) => ['--exclude', s])
        await asAgent(`tar -czf ${q(join(stage, 'agents.tar.gz'))} --exclude ./.migrate --exclude ./.trash ${skip.map(q).join(' ')} -C ${q(AGENTS_DIR)} .`, AGENTS_DIR, [0, 1])
        agentFiles.push('agents.tar.gz')
        for (const [i, root] of roots.entries()) {
          step(`Packing ${basename(root)}`)
          await asAgent(`tar -czf ${q(join(stage, `root-${i}.tar.gz`))} ${skip.map(q).join(' ')} -C ${q(root)} .`, AGENTS_DIR, [0, 1])
          agentFiles.push(`root-${i}.tar.gz`)
        }
      }
      if (opts.conversations) {
        step('Packing the conversations')
        for (const a of agentsRepo.all()) {
          const dir = join(CLAUDE_PROJECTS_DIR, convName(a.cwd))
          const file = `conv-${a.id}.tar.gz`
          // an agent that never talked has none: skipped
          const out = await asAgent(`[ -d ${q(dir)} ] || { echo none; exit 0; }; tar -czf ${q(join(stage, file))} -C ${q(dir)} .`, AGENTS_DIR, [0, 1]).catch(() => 'none')
          if (out.trim() === 'none') continue
          conversations[a.id] = a.cwd
          agentFiles.push(file)
        }
      }
      const manifest: Manifest = {
        format: FORMAT,
        version: 1,
        createdAt: Date.now(),
        from: hostname(),
        agentHome: AGENT_HOME,
        agentsDir: AGENTS_DIR,
        claudeProjectsDir: CLAUDE_PROJECTS_DIR,
        roots,
        folders: !!opts.folders,
        conversations,
      }
      writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2))
      // one file: the agents' archives are already compressed
      step('Writing the export file')
      rmSync(EXPORTS, { recursive: true, force: true })
      mkdirSync(EXPORTS, { recursive: true, mode: 0o700 })
      const name = `after-office-export-${id}.tar`
      const file = join(EXPORTS, name)
      await run(['tar', '-cf', file, '-C', work, 'manifest.json', 'db.sqlite.gz', 'secrets.json', 'data.tar.gz', ...(agentFiles.length ? ['-C', stage, ...agentFiles] : [])])
      chmodSync(file, 0o600)
      exportFile = file
      current.size = statSync(file).size
      current.name = name
      current.step = 'Ready to download'
      current.done = true
    } catch (e) {
      current.error = e instanceof Error ? e.message : String(e)
      current.done = true
    } finally {
      rmSync(work, { recursive: true, force: true })
      if (opts.folders || opts.conversations) await asAgent(`rm -rf ${q(stage)}`).catch(() => {})
    }
  })()
  return job
}

// ── import: the upload (in pieces: requests are limited in size), then the import ──

let upload: { id: string; file: string; size: number; until: number } | null = null

export function startUpload() {
  busy()
  const id = crypto.randomUUID()
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true, mode: 0o700 })
  upload = { id, file: join(WORK, `upload-${id}.tar`), size: 0, until: Date.now() + 6 * HOUR }
  writeFileSync(upload.file, '', { mode: 0o600 })
  return { id, chunk: CHUNK }
}

export function addChunk(id: string, offset: number, bytes: Uint8Array) {
  if (!upload || upload.id !== id || upload.until < Date.now()) throw new AgentError('This upload is over: start again', 404)
  if (offset !== upload.size) throw new AgentError(`Expected the piece at ${upload.size}`, 409)
  if (bytes.byteLength > CHUNK) throw new AgentError('Piece too large', 413)
  appendFileSync(upload.file, bytes)
  upload.size += bytes.byteLength
  return { size: upload.size }
}

const MEMBER = /^(manifest\.json|db\.sqlite\.gz|secrets\.json|data\.tar\.gz|agents\.tar\.gz|root-\d{1,3}\.tar\.gz|conv-[\w-]{1,64}\.tar\.gz)$/

async function members(file: string) {
  const p = Bun.spawn(['tar', '-tf', file], { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(p.stdout).text()
  if ((await p.exited) !== 0) throw new AgentError("That isn't an After Office export file", 400)
  return out.split('\n').map((s) => s.replace(/^\.\//, '')).filter(Boolean)
}

/** Stop every agent session of this server (the database being replaced is theirs). */
async function stopAgents() {
  for (const a of agentsRepo.all()) await tmux.killSession(a.tmux_session).catch(() => {})
  for (const s of sideSessionsRepo.open()) await tmux.killSession(s.tmux_session).catch(() => {})
}

/** Check the upload (its contents, the passphrase), then import it in the background; the server restarts after. */
export async function startImport(opts: { id: unknown; passphrase: unknown }) {
  busy()
  const secret = serverSecret()
  const pass = checkPassphrase(opts.passphrase)
  if (!upload || upload.id !== opts.id) throw new AgentError('Upload the file first', 400)
  const { file } = upload
  const names = await members(file)
  if (!names.includes('manifest.json') || !names.includes('db.sqlite.gz') || !names.includes('secrets.json') || names.some((n) => !MEMBER.test(n)))
    throw new AgentError("That isn't an After Office export file", 400)
  const work = join(WORK, 'import')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true, mode: 0o700 })
  await run(['tar', '-xf', file, '-C', work, 'manifest.json', 'secrets.json'])
  const manifest = JSON.parse(readFileSync(join(work, 'manifest.json'), 'utf8')) as Manifest
  if (manifest.format !== FORMAT || manifest.version !== 1) throw new AgentError('This export is from another version of After Office', 400)
  // the passphrase is checked now, before anything here changes
  const secrets = unlock(JSON.parse(readFileSync(join(work, 'secrets.json'), 'utf8')), pass)

  job = { kind: 'import', step: 'Starting', done: false, startedAt: Date.now() }
  const current = job
  const step = (s: string) => (current.step = s)
  const id = stamp()
  const stage = join(STAGE, id)
  void (async () => {
    try {
      step('Unpacking')
      await run(['tar', '-xf', file, '-C', work])
      rmSync(file, { force: true })
      upload = null
      step('Backing up this server’s database')
      await backupNow()

      // where the old server's folders land here (the longest first, so nested ones are moved before their parents)
      const roots = extraRoots()
      const rootTo = manifest.roots.map((old) => roots.find((r) => basename(r) === basename(old)) ?? join(AGENTS_DIR, basename(old)))
      const moves = (
        [
          [manifest.agentsDir, AGENTS_DIR],
          ...manifest.roots.map((old, i) => [old, rootTo[i]]),
          [manifest.claudeProjectsDir, CLAUDE_PROJECTS_DIR],
          [manifest.agentHome, AGENT_HOME],
        ] as [string, string][]
      )
        .filter(([a, b]) => a && a !== b)
        .sort((a, b) => b[0].length - a[0].length)
      const moved = (path: string) => {
        for (const [a, b] of moves) if (inside(path, a)) return b + path.slice(a.length)
        return path
      }

      step('Preparing the database')
      const part = `${PENDING_DB}.part`
      writeFileSync(part, Bun.gunzipSync(readFileSync(join(work, 'db.sqlite.gz'))), { mode: 0o600 })
      const next = new Database(part)
      if (next.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('The database in the file is damaged')
      const cols = textColumns(next)
      next.transaction(() => {
        for (const { table, column } of cols) {
          for (const [a, b] of moves) next.run(`UPDATE "${table}" SET "${column}" = REPLACE("${column}", ?1, ?2) WHERE instr("${column}", ?1) > 0`, [a, b])
          // sealed with the old server's key: sealed again with this one's
          for (const [old, plain] of Object.entries(secrets)) next.run(`UPDATE "${table}" SET "${column}" = REPLACE("${column}", ?1, ?2) WHERE instr("${column}", ?1) > 0`, [old, seal(plain, secret)])
        }
      })()
      next.close()

      // the agents running here belong to the database being replaced
      step('Stopping this server’s agents')
      revivePause.on = true
      await stopAgents()

      step('Putting the dashboard files back')
      if (existsSync(join(work, 'data.tar.gz'))) {
        for (const d of ['profile', 'branding']) rmSync(join(DATA_DIR, d), { recursive: true, force: true })
        await run(['tar', '-xzf', join(work, 'data.tar.gz'), '-C', DATA_DIR])
      }

      // the agents' archives go where their user can read them; what's in their folders now goes to the trash
      const agentFiles = readdirSync(work).filter((n) => n === 'agents.tar.gz' || /^(root|conv)-/.test(n))
      if (agentFiles.length) {
        await asAgent(`mkdir -p ${q(stage)} && chmod 755 ${q(stage)}`)
        for (const n of agentFiles) {
          renameSync(join(work, n), join(stage, n))
          chmodSync(join(stage, n), 0o644)
        }
      }
      const trash = join(AGENTS_DIR, '.trash', `before-import-${id}`)
      const clearOut = (dir: string, into: string) =>
        `mkdir -p ${q(into)} && cd ${q(dir)} && for f in * .[!.]* ..?*; do [ -e "$f" ] || continue; case "$f" in .trash|.migrate) continue;; esac; mv -- "$f" ${q(into)}/; done`
      if (agentFiles.includes('agents.tar.gz')) {
        step('Restoring the agents’ folders (the old ones go to the trash)')
        await asAgent(`${clearOut(AGENTS_DIR, join(trash, 'agents'))} && tar -xzf ${q(join(stage, 'agents.tar.gz'))} -C ${q(AGENTS_DIR)}`)
      }
      for (const [i, to] of rootTo.entries()) {
        if (!agentFiles.includes(`root-${i}.tar.gz`)) continue
        step(`Restoring ${basename(to)}`)
        await asAgent(`mkdir -p ${q(to)} && ${clearOut(to, join(trash, `root-${i}`))} && tar -xzf ${q(join(stage, `root-${i}.tar.gz`))} -C ${q(to)}`)
      }
      const conv = Object.entries(manifest.conversations).filter(([agentId]) => agentFiles.includes(`conv-${agentId}.tar.gz`))
      if (conv.length) {
        step('Restoring the conversations')
        for (const [agentId, oldCwd] of conv) {
          const dir = join(CLAUDE_PROJECTS_DIR, convName(moved(oldCwd)))
          await asAgent(`mkdir -p ${q(dir)} && tar -xzf ${q(join(stage, `conv-${agentId}.tar.gz`))} -C ${q(dir)}`)
        }
      }
      if (agentFiles.length) await asAgent(`rm -rf ${q(stage)}`).catch(() => {})

      // in place when the server starts again (db.ts): the database can't be swapped under the running server
      renameSync(part, PENDING_DB)
      rmSync(work, { recursive: true, force: true })
      current.step = 'Done: the server restarts now'
      current.restarting = true
      current.done = true
      // a moment for the browser to see it; a service manager (systemd) starts the server again
      setTimeout(() => void stopAgents().finally(() => afterImport.restart()), 2500)
    } catch (e) {
      current.error = e instanceof Error ? e.message : String(e)
      current.done = true
      rmSync(`${PENDING_DB}.part`, { force: true })
      // nothing was swapped: the agents come back as they were
      revivePause.on = false
    }
  })()
  return job
}
