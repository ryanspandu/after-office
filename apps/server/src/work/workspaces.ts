import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, writeSync } from 'node:fs'
import { zip, type ZipEntry } from './zip'
import type { FolderEntry, FolderListing } from '@after-office/shared'
import { IMAGE, MAX_BYTES } from '../agents/files'
import { deleteAgentFolder } from './projectFolders'
import { basename, dirname, extname, join, sep } from 'node:path'
import type { FolderGit, GitCommit, GitInfo, Workspace, WorkspaceFolder } from '@after-office/shared'
import { agentsRepo, extraDirsOf, folderNotesRepo, ownerNotesRepo, reportsRepo, settingsRepo, type AgentRow } from '../db'
import { AgentError } from '../agents/errors'
import { AGENTS_DIR, PROJECTS_DIR } from '../fsroots'
import { git } from './git'
import { runAsAgent } from '../agents/asagent'
import { gitEnv } from '../agents/git'

// The Projects tab: what the agents are working on, read from their folders. An agent's folder that is a git repo
// is one project; any other folder is a home for several, one per subfolder. Git runs with the agents' rights and
// safe flags (work/git.ts). The only writes: a file the owner uploads into a folder (addFolderFile), a new folder (addFolder).

const MAX_PROJECTS = 40
const SKIP = new Set(['node_modules', 'dist', 'build', 'venv', '__pycache__'])
/** Files that mark a folder as one project (so its own subfolders are code, not projects), git or not. */
const PROJECT_MARKERS = [
  'package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'composer.json', 'Gemfile', 'pom.xml',
  'build.gradle', 'deno.json', 'mix.exs', 'pubspec.yaml', 'Package.swift', 'CMakeLists.txt', 'Makefile', 'README.md',
]
const isProjectRoot = (path: string) => PROJECT_MARKERS.some((f) => existsSync(join(path, f)))

async function gitInfo(path: string): Promise<GitInfo | null> {
  const inside = await git(path, ['rev-parse', '--show-toplevel'])
  if (!inside.ok) return null
  // a folder inside someone else's repo is not a project of its own
  try {
    if (realpathSync(inside.out.trim()) !== realpathSync(path)) return null
  } catch {
    return null
  }
  const [branch, status, last] = await Promise.all([
    git(path, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(path, ['status', '--porcelain=v1', '--untracked-files=normal', '--no-renames']),
    git(path, ['log', '-1', '--format=%s%x00%ct']),
  ])
  const [subject, at] = last.ok ? last.out.trim().split('\0') : []
  return {
    branch: branch.ok ? branch.out.trim() || null : null,
    dirty: status.ok ? status.out.split('\n').filter(Boolean).length : 0,
    lastCommit: subject !== undefined && at ? { subject: subject.slice(0, 200), at: Number(at) * 1000 } : null,
  }
}

/**
 * The git repo of a folder in the Files browser (it or a parent of it): branch, ahead / behind its upstream, what's
 * not committed yet (and which entries of the folder on screen that touches), the last commit. null: not in a repo.
 */
export async function folderGit(root: string, rel = ''): Promise<FolderGit | null> {
  const { real } = inside(root, rel)
  if (!lstatSync(real).isDirectory()) throw new AgentError('Not a folder', 400)
  const top = await git(real, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return null
  const repoTop = top.out.trim()
  const [branch, status, last, counts, prefix, remotes] = await Promise.all([
    git(real, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(real, ['status', '--porcelain=v1', '--untracked-files=normal']),
    git(real, ['log', '-1', '--format=%s%x00%ct%x00%an']),
    git(real, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
    git(real, ['rev-parse', '--show-prefix']),
    git(real, ['remote']),
  ])
  const owner = gitOwner(repoTop)
  // paths in `git status` are from the repo's top; the folder on screen is `here` below it
  const here = prefix.ok ? prefix.out.trim() : ''
  const entries: FolderGit['entries'] = {}
  const lines = status.ok ? status.out.split('\n').filter(Boolean) : []
  for (const line of lines) {
    const xy = line.slice(0, 2)
    let path = line.slice(3)
    if (path.includes(' -> ')) path = path.split(' -> ')[1]
    path = path.replace(/^"|"$/g, '')
    if (!path.startsWith(here)) continue
    const name = path.slice(here.length).split('/')[0]
    if (!name) continue
    const code: FolderGit['entries'][string] = xy === '??' ? 'U' : xy.includes('D') ? 'D' : xy.includes('R') ? 'R' : xy[0] === 'A' ? 'A' : 'M'
    // a folder with several changes inside: changed (M) unless they're all the same kind
    entries[name] = entries[name] && entries[name] !== code ? 'M' : code
  }
  const [subject, at, author] = last.ok ? last.out.trim().split('\0') : []
  const [behind, ahead] = counts.ok ? counts.out.trim().split(/\s+/).map(Number) : []
  const head = branch.ok ? branch.out.trim() : ''
  return {
    repo: basename(repoTop),
    branch: head && head !== 'HEAD' ? head : null,
    ...(counts.ok && Number.isFinite(ahead) ? { ahead, behind } : {}),
    dirty: lines.length,
    lastCommit: subject !== undefined && at ? { subject: subject.slice(0, 200), at: Number(at) * 1000, author: (author ?? '').slice(0, 80) } : null,
    entries,
    hasRemote: remotes.ok && !!remotes.out.trim(),
    committer: owner ? { agentId: owner.id, name: owner.name, hasKey: !!owner.ssh_fingerprint, picked: !!settingsRepo.get(`gitAs:${repoTop}`) } : null,
  }
}

// ── Discard / Commit / Push from the Files browser (the whole repo of the folder on screen) ──

/**
 * Whose git identity a repo's commits, pulls and pushes use. The one picked for this repo (the git bar's "as"), else of
 * the agents that work there (their folder holds it, it's an extra folder of theirs, or they filed reports from it)
 * the one with an SSH key, then the deepest folder, then the most recent report; else the manager. Their gitconfig has
 * the name, email and SSH key.
 */
export function gitOwner(repo: string): AgentRow | undefined {
  const agents = agentsRepo.all()
  const picked = settingsRepo.get(`gitAs:${repo}`)
  const chosen = picked ? agents.find((a) => a.id === picked) : undefined
  if (chosen) return chosen
  // git gives the repo's real path; a folder may be named through a symlink (macOS /var → /private/var)
  const real = (dir: string) => {
    try {
      return realpathSync(dir)
    } catch {
      return dir
    }
  }
  const within = (dir: string | null | undefined) => {
    if (!dir) return false
    const d = real(dir).replace(/\/+$/, '')
    return repo === d || repo.startsWith(d + sep)
  }
  // the latest report each agent filed from a folder in this repo
  const lastReport = new Map<string, number>()
  for (const r of reportsRepo.latest(1000)) {
    // a report from this repo (or a folder inside it)
    const at = r.folder ? real(r.folder) : ''
    if (!at || !(at === repo || at.startsWith(repo + sep))) continue
    if (!lastReport.has(r.agentId)) lastReport.set(r.agentId, r.finishedAt)
  }
  const ranked = agents
    .map((a) => {
      const depth = within(a.cwd) ? a.cwd.length : 0
      const extra = extraDirsOf(a).some(within)
      const reported = lastReport.get(a.id) ?? 0
      return { a, depth, extra, reported, key: !!a.ssh_fingerprint }
    })
    .filter((c) => c.depth || c.extra || c.reported)
    .sort((x, y) => Number(y.key) - Number(x.key) || y.depth - x.depth || Number(y.extra) - Number(x.extra) || y.reported - x.reported)
  return ranked[0]?.a ?? agents.find((a) => a.kind === 'manager')
}

/** Pick whose identity this repo's commits, pulls and pushes use ('' : back to the automatic choice). */
export async function setGitAs(root: string, rel: string, agentId: unknown) {
  const top = await repoOf(root, rel)
  const id = typeof agentId === 'string' ? agentId : ''
  if (id && !agentsRepo.get(id)) throw new AgentError('No such agent', 404)
  if (id) settingsRepo.set(`gitAs:${top}`, id)
  else settingsRepo.delete(`gitAs:${top}`)
  return { ok: true }
}

// writing: no hooks or fsmonitor from the repo's config (the dashboard's commit isn't the place for them), no pager
const WRITE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat']

async function gitWrite(top: string, who: AgentRow | null | undefined, args: string[], timeoutMs = 30_000) {
  // the agent's gitconfig (written first, as its session does): its name, email and SSH key
  const vars = who ? await gitEnv(who) : {}
  const env = ['env', 'GIT_TERMINAL_PROMPT=0', ...Object.entries(vars).map(([k, v]) => `${k}=${v}`)]
  const r = await runAsAgent([...env, 'git', ...WRITE, '-C', top, ...args], { cwd: top, timeoutMs, mergeStderr: true })
  return { ok: r.code === 0, out: r.out.trim(), timedOut: r.timedOut }
}
/** The last lines of git's words: what to show when it fails. */
const said = (out: string) => out.split('\n').filter((l) => l.trim() && !/^hint:/.test(l)).slice(-3).join(' ').slice(0, 400)

async function repoOf(root: string, rel: string) {
  const { real } = inside(root, rel)
  if (!lstatSync(real).isDirectory()) throw new AgentError('Not a folder', 400)
  const top = await git(real, ['rev-parse', '--show-toplevel'])
  if (!top.ok) throw new AgentError('This folder is not in a git repository', 400)
  return top.out.trim()
}

/** Throw away every change not committed: tracked files back as committed, new files removed (ignored ones and the
 *  office's own .claude / .mcp.json stay). */
export async function gitDiscard(root: string, rel = '') {
  const top = await repoOf(root, rel)
  await gitWrite(top, undefined, ['reset', '-q'])
  // a repo without a commit has nothing to go back to: only the new files go
  await gitWrite(top, undefined, ['checkout', '--', '.'])
  const clean = await gitWrite(top, undefined, ['clean', '-fd', '-e', '.claude', '-e', '.mcp.json'])
  if (!clean.ok) throw new AgentError(`Could not discard: ${said(clean.out)}`, 400)
  return { ok: true }
}

/** Commit everything not committed yet, as the folder's agent (or the one picked). */
export async function gitCommit(root: string, rel: string, messageIn: unknown, agentId?: string) {
  const message = typeof messageIn === 'string' ? messageIn.trim().slice(0, 5000) : ''
  if (!message) throw new AgentError('Write a commit message', 400)
  const top = await repoOf(root, rel)
  const who = agentId ? agentsRepo.get(agentId) : gitOwner(top)
  if (agentId && !who) throw new AgentError('No such agent', 404)
  const add = await gitWrite(top, who, ['add', '-A'])
  if (!add.ok) throw new AgentError(`Could not stage the changes: ${said(add.out)}`, 400)
  const commit = await gitWrite(top, who, ['commit', '-q', '-m', message])
  if (!commit.ok) {
    if (/nothing to commit|no changes added/i.test(commit.out)) throw new AgentError('Nothing to commit', 400)
    if (/tell me who you are|empty ident/i.test(commit.out)) throw new AgentError(`${who?.name ?? 'The agent'} has no git name and email yet: set them in its Overview → Git`, 400)
    throw new AgentError(`Could not commit: ${said(commit.out)}`, 400)
  }
  const head = await git(top, ['log', '-1', '--format=%h%x00%s'])
  const [hash, subject] = head.out.trim().split('\0')
  return { ok: true, hash, subject, as: who?.name ?? null }
}

/** A branch name git would take, and one that can't be read as an option (-x) or a path trick. */
const BRANCH = /^(?!-)[A-Za-z0-9._\/+@#-]{1,200}$/
const cleanBranch = (v: unknown) => {
  const b = typeof v === 'string' ? v.trim() : ''
  if (!BRANCH.test(b) || b.includes('..') || b.endsWith('/') || b.endsWith('.lock')) throw new AgentError('That is not a branch name', 400)
  return b
}

/** The repo's branches: the one checked out, the local ones, and the remote ones that have no local copy yet. */
export async function gitBranches(root: string, rel = '') {
  const top = await repoOf(root, rel)
  const r = await git(top, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(refname:short)%00%(HEAD)', 'refs/heads', 'refs/remotes'])
  const local: string[] = []
  const remote: string[] = []
  let current: string | null = null
  for (const line of r.out.split('\n').filter(Boolean)) {
    const [full, short, head] = line.split('\0')
    if (full.startsWith('refs/heads/')) {
      local.push(short)
      if (head === '*') current = short
    } else if (full.startsWith('refs/remotes/') && !full.endsWith('/HEAD')) {
      // origin/feature → feature (the one remote's); a local copy of it hides it
      remote.push(short.slice(short.indexOf('/') + 1))
    }
  }
  return { current, local, remote: [...new Set(remote)].filter((b) => !local.includes(b)) }
}

/** Switch to a branch (a remote one gets a local copy that follows it). Changes git can carry over come along; ones
 *  that would be overwritten stop it, and git says so. */
export async function gitSwitch(root: string, rel: string, branchIn: unknown) {
  const branch = cleanBranch(branchIn)
  const top = await repoOf(root, rel)
  const r = await gitWrite(top, gitOwner(top), ['switch', branch])
  if (!r.ok) {
    if (/would be overwritten|local changes|commit your changes or stash/i.test(r.out)) throw new AgentError('You have changes that would be lost by switching: commit or discard them first', 409)
    if (/invalid reference|did not match|unknown/i.test(r.out)) throw new AgentError(`There is no branch called "${branch}"`, 404)
    throw new AgentError(`Could not switch: ${said(r.out)}`, 400)
  }
  return { ok: true, branch }
}

/** Fetch and bring the branch up to date, only when that is a straight catch-up (no merge commits, no conflicts). */
export async function gitPull(root: string, rel = '', agentId?: string) {
  const top = await repoOf(root, rel)
  const who = agentId ? agentsRepo.get(agentId) : gitOwner(top)
  const r = await gitWrite(top, who, ['pull', '--ff-only'], 90_000)
  if (!r.ok) {
    if (r.timedOut) throw new AgentError('Pull took too long (the remote did not answer)', 500)
    if (/permission denied|could not read from remote|authentication failed|publickey/i.test(r.out))
      throw new AgentError(`The remote refused ${who?.name ?? 'the agent'}'s key: add its SSH key (Overview → Git) to the repo host. ${said(r.out)}`, 400)
    if (/no tracking information|no upstream/i.test(r.out)) throw new AgentError('This branch is not on the remote yet: push it first', 400)
    if (/not possible to fast-forward|diverge|refusing to merge/i.test(r.out)) throw new AgentError('Your branch and the remote both have new commits: this needs a merge, which an agent should do', 409)
    if (/would be overwritten|local changes|commit your changes or stash/i.test(r.out)) throw new AgentError('You have changes that the pull would overwrite: commit or discard them first', 409)
    throw new AgentError(`Could not pull: ${said(r.out)}`, 400)
  }
  return { ok: true, upToDate: /already up to date/i.test(r.out) }
}

/** Push the branch, as the folder's agent (its SSH key). No upstream yet: to origin, under the same name. */
export async function gitPush(root: string, rel = '', agentId?: string) {
  const top = await repoOf(root, rel)
  const who = agentId ? agentsRepo.get(agentId) : gitOwner(top)
  const upstream = await git(top, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  let args = ['push']
  if (!upstream.ok) {
    const remotes = (await git(top, ['remote'])).out.split('\n').map((r) => r.trim()).filter(Boolean)
    if (!remotes.length) throw new AgentError('This repo has no remote to push to', 400)
    args = ['push', '-u', remotes.includes('origin') ? 'origin' : remotes[0], 'HEAD']
  }
  const r = await gitWrite(top, who, args, 90_000)
  if (!r.ok) {
    if (r.timedOut) throw new AgentError('Push took too long (the remote did not answer)', 500)
    if (/permission denied|could not read from remote|authentication failed|publickey/i.test(r.out))
      throw new AgentError(`The remote refused ${who?.name ?? 'the agent'}'s key: add its SSH key (Overview → Git) to the repo host. ${said(r.out)}`, 400)
    if (/rejected|non-fast-forward|fetch first/i.test(r.out)) throw new AgentError('The remote has commits you don\'t have yet: pull them first (ask the agent), then push', 409)
    throw new AgentError(`Could not push: ${said(r.out)}`, 400)
  }
  return { ok: true, as: who?.name ?? null }
}

async function folder(path: string): Promise<WorkspaceFolder> {
  let updatedAt = 0
  try {
    updatedAt = lstatSync(path).mtimeMs
  } catch {
    // gone
  }
  return { path, name: basename(path), git: await gitInfo(path), updatedAt }
}

/** Plain, visible subfolders (no symlinks: they could lead anywhere). */
function subfolders(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.isSymbolicLink() && !d.name.startsWith('.') && !SKIP.has(d.name))
      .map((d) => join(path, d.name))
      .slice(0, MAX_PROJECTS)
  } catch {
    return []
  }
}

let cache: { at: number; data: Workspace[] } | null = null

export async function workspaces(fresh = false): Promise<Workspace[]> {
  if (!fresh && cache && Date.now() - cache.at < 20_000) return cache.data
  const byPath = new Map<string, string[]>()
  for (const a of agentsRepo.all()) byPath.set(a.cwd, [...(byPath.get(a.cwd) ?? []), a.id])
  const data = await Promise.all(
    [...byPath].map(async ([path, agentIds]) => {
      const self = await folder(path)
      // a repo or a project folder is one project; any other folder (an agent's home) holds several
      const isProject = !!self.git || isProjectRoot(path)
      const projects = isProject ? [] : await Promise.all(subfolders(path).map(folder))
      projects.sort((a, b) => b.updatedAt - a.updatedAt)
      return { ...self, agentIds, isProject, projects } as Workspace
    }),
  )
  data.sort((a, b) => a.name.localeCompare(b.name))
  // folders in the agents' folder whose agent is gone (removed without deleting its folder): still there to look
  // into, marked as without an agent, and deletable from the dashboard
  for (const path of orphanFolders()) {
    const self = await folder(path)
    const isProject = !!self.git || isProjectRoot(path)
    const projects = isProject ? [] : await Promise.all(subfolders(path).map(folder))
    projects.sort((a, b) => b.updatedAt - a.updatedAt)
    data.push({ ...self, agentIds: [], isProject, orphan: true, projects })
  }
  // the projects folder: one entry per project folder in it; agents given one of them (extra dirs) are listed
  if (existsSync(PROJECTS_DIR) && !byPath.has(PROJECTS_DIR)) {
    const self = await folder(PROJECTS_DIR)
    const projects = await Promise.all(subfolders(PROJECTS_DIR).map(folder))
    projects.sort((a, b) => b.updatedAt - a.updatedAt)
    const agentIds = agentsRepo
      .all()
      .filter((a) => extraDirsOf(a).some((d) => d.startsWith(PROJECTS_DIR + sep)))
      .map((a) => a.id)
    data.push({ ...self, name: 'project', agentIds, isProject: false, shared: true, projects })
  }
  cache = { at: Date.now(), data }
  return data
}

/** Real folders directly in the agents' folder that no agent (or pending hire) works in, apart from the projects folder. */
export function orphanFolders(): string[] {
  const used = new Set<string>()
  for (const a of agentsRepo.all()) {
    for (const d of [a.cwd, ...extraDirsOf(a)]) {
      try {
        used.add(realpathSync(d))
      } catch {
        // gone
      }
    }
  }
  let names: string[] = []
  try {
    names = readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.isSymbolicLink() && !d.name.startsWith('.'))
      .map((d) => d.name)
  } catch {
    return []
  }
  return names
    .map((n) => join(AGENTS_DIR, n))
    .filter((p) => p !== PROJECTS_DIR && ![...used].some((u) => u === p || u.startsWith(p + sep)))
    .sort()
    .slice(0, MAX_PROJECTS)
}

/** Only folders the Projects tab shows: an agent's folder, or a direct subfolder of one. */
function allowed(path: string) {
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    throw new AgentError('No such folder', 404)
  }
  // a folder at any depth inside the projects folder, a folder without an agent, or an agent's folder (its real path:
  // a link that leads out of them is refused), and nothing hidden (.git…) on the way
  const inRoot = (root: string) => {
    if (real === root) return true
    if (!real.startsWith(root + sep)) return false
    return !real
      .slice(root.length + 1)
      .split(sep)
      .some((part) => part.startsWith('.'))
  }
  for (const root of [PROJECTS_DIR, ...orphanFolders()]) if (inRoot(root)) return real
  for (const a of agentsRepo.all()) {
    let root: string
    try {
      root = realpathSync(a.cwd)
    } catch {
      continue
    }
    if (inRoot(root)) return real
  }
  throw new AgentError('Not an agent folder', 403)
}

/** The folder (one the Projects tab may show: the projects folder's, an agent's or a folder without an agent), real path. */
export const folderOf = (path: string) => allowed(path)

export async function recentCommits(path: string, limit = 10): Promise<GitCommit[]> {
  const real = allowed(path)
  const r = await git(real, ['log', `-${Math.min(30, Math.max(1, limit))}`, '--format=%h%x00%s%x00%an%x00%ct'])
  if (!r.ok) return []
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, subject, author, at] = line.split('\0')
      return { hash, subject: subject.slice(0, 200), author: author.slice(0, 80), at: Number(at) * 1000 }
    })
}

// ── file manager (read-only): the files inside a folder the Projects tab shows ──

const MAX_ENTRIES = 500

/** `rel` inside the allowed folder `root`, symlinks resolved; never outside it. */
function inside(root: string, rel: string) {
  const base = allowed(root)
  if (rel.includes('\0') || rel.length > 4096) throw new AgentError('Invalid path', 400)
  const target = join(base, rel)
  let real: string
  try {
    real = realpathSync(target)
  } catch {
    throw new AgentError('No such file or folder', 404)
  }
  if (real !== base && !real.startsWith(base + sep)) throw new AgentError('Outside this folder', 403)
  return { base, real }
}

/** The entries of a folder inside `root`: folders first, hidden ones (.git, .claude, .env…) left out unless `hidden`. */
export function listFolder(root: string, rel = '', hidden = false): FolderListing {
  const { base, real } = inside(root, rel)
  if (!lstatSync(real).isDirectory()) throw new AgentError('Not a folder', 400)
  const entries: FolderEntry[] = []
  let total = 0
  for (const d of readdirSync(real, { withFileTypes: true })) {
    if (!hidden && d.name.startsWith('.')) continue
    total++
    if (entries.length >= MAX_ENTRIES) continue
    try {
      const st = lstatSync(join(real, d.name))
      const link = st.isSymbolicLink()
      entries.push({
        name: d.name,
        dir: st.isDirectory(),
        size: st.isFile() ? st.size : 0,
        updatedAt: st.mtimeMs,
        ...(link ? { link: true } : {}),
        ...(st.isFile() && IMAGE.has(extname(d.name).toLowerCase()) ? { image: true } : {}),
      })
    } catch {
      // vanished while listing
    }
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
  return { root: base, path: real === base ? '' : real.slice(base.length + 1), entries, more: Math.max(0, total - entries.length) }
}

// ── text files: read and edited in place (the Files browser's editor) ──

/** Largest text file the editor opens. */
export const TEXT_MAX = 1024 * 1024

/** Files the office keeps as they are (its hooks, its MCP connection) or that git owns: read, never written here. */
const keptByOffice = (rel: string) => {
  const parts = rel.split('/').filter(Boolean)
  return parts.includes('.git') || parts.at(-1) === '.mcp.json' || /(^|\/)\.claude\/settings(\.local)?\.json$/.test(parts.join('/'))
}

/** A plain file inside `root` (no symlink), for the editor. */
function textTarget(root: string, rel: string) {
  if (!rel || rel.split('/').some((p) => p === '..')) throw new AgentError('Invalid path', 400)
  const { real } = inside(root, rel)
  const st = lstatSync(real)
  if (st.isSymbolicLink() || !st.isFile()) throw new AgentError('Not a file', 400)
  return { real, st }
}

/** A text file's contents (UTF-8, no NUL bytes, at most TEXT_MAX), when it was changed, and whether it may be edited. */
export function readTextFile(root: string, rel: string) {
  const { real, st } = textTarget(root, rel)
  if (st.size > TEXT_MAX) throw new AgentError(`Too big to edit here (over ${TEXT_MAX / 1024 / 1024} MB)`, 413)
  const bytes = readFileSync(real)
  if (bytes.subarray(0, 8000).includes(0)) throw new AgentError("That isn't a text file", 400)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new AgentError("That isn't a UTF-8 text file", 400)
  }
  return { text, size: st.size, updatedAt: st.mtimeMs, editable: !keptByOffice(rel) }
}

/**
 * Save a text file in place (its owner and mode stay: the agents can still edit it). `since`: when it was changed as
 * the editor opened it; changed after that (an agent wrote it meanwhile), the save is refused unless forced.
 */
export function writeTextFile(root: string, rel: string, text: string, since?: number, force = false) {
  if (keptByOffice(rel)) throw new AgentError('The office manages this file: it can be read here, not changed', 403)
  const { real, st } = textTarget(root, rel)
  const data = new TextEncoder().encode(text)
  if (data.byteLength > TEXT_MAX) throw new AgentError(`Too big to save here (over ${TEXT_MAX / 1024 / 1024} MB)`, 413)
  if (!force && since !== undefined && Math.abs(st.mtimeMs - since) > 1)
    throw new AgentError('It changed since you opened it (an agent may have written it). Reload it, or save anyway.', 409)
  const fd = openSync(real, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW)
  try {
    writeSync(fd, data)
  } finally {
    closeSync(fd)
  }
  const after = lstatSync(real)
  return { size: after.size, updatedAt: after.mtimeMs }
}

/** A file inside `root` for preview / download: a real file (no symlink), not too big. */
/**
 * Folders whose name has `q` in it, inside the projects folder and the agents' folders (the folder picker's search):
 * up to a few levels deep, nothing hidden, no links followed, no dependency / build folders. At most 50.
 */
export function searchFolders(q: string, maxDepth = 5): { path: string; name: string; under: string }[] {
  const needle = q.trim().toLowerCase()
  if (needle.length < 1) return []
  const roots = [PROJECTS_DIR, ...agentsRepo.all().map((a) => a.cwd)].filter((r, i, all) => existsSync(r) && all.indexOf(r) === i)
  const out: { path: string; name: string; under: string }[] = []
  const seen = new Set<string>()
  const walk = (dir: string, depth: number, root: string) => {
    if (out.length >= 50 || depth > maxDepth) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of entries) {
      if (!d.isDirectory() || d.name.startsWith('.') || SKIP.has(d.name)) continue
      const path = join(dir, d.name)
      if (seen.has(path)) continue
      seen.add(path)
      if (d.name.toLowerCase().includes(needle)) {
        out.push({ path, name: d.name, under: path.slice(0, path.length - d.name.length - 1) })
        if (out.length >= 50) return
      }
      walk(path, depth + 1, root)
    }
  }
  for (const root of roots) walk(root, 1, root)
  return out
}

/**
 * A file or folder `rel` inside the allowed folder `root`, without following it (a link is the link itself): its parent
 * must really be inside `root`, nothing hidden on the way, and not `root` itself.
 */
export function entryIn(root: string, rel: string) {
  const parts = rel.split('/').filter(Boolean)
  if (!parts.length || rel.includes('\0') || parts.some((p) => p === '..' || p === '.' || p.startsWith('.'))) throw new AgentError('Invalid path', 400)
  const base = allowed(root)
  let parent: string
  try {
    parent = realpathSync(join(base, ...parts.slice(0, -1)))
  } catch {
    throw new AgentError('No such file or folder', 404)
  }
  if (parent !== base && !parent.startsWith(base + sep)) throw new AgentError('Outside this folder', 403)
  const abs = join(parent, parts[parts.length - 1])
  let st: import('node:fs').Stats
  try {
    st = lstatSync(abs)
  } catch {
    throw new AgentError('No such file or folder', 404)
  }
  return { base, abs, st, rel: parts.join('/') }
}

/** Rename a file or folder in place (same folder, a plain new name, never over something that's there). */
export function renameEntry(root: string, rel: string, name: string) {
  const { abs } = entryIn(root, rel)
  const next = name.trim()
  if (!next || next.startsWith('.') || next.length > 200 || /[/\\\0]/.test(next)) throw new AgentError('Give it a plain name (no slashes, not starting with a dot)')
  const to = join(dirname(abs), next)
  if (to === abs) return { name: next }
  if (existsSync(to)) throw new AgentError(`${next} is already there`, 409)
  renameSync(abs, to)
  folderNotesRepo.move(abs, to)
  ownerNotesRepo.moveFolder(abs, to)
  return { name: next }
}

/** Largest file the owner can upload into a folder. */
export const UPLOAD_MAX = 20 * 1024 * 1024

/**
 * A file the owner uploads into the folder on screen (the Files browser): the same rules as browsing (inside `root`,
 * no links out, nothing hidden), a plain name, and never over an existing file.
 */
export function addFolderFile(root: string, rel: string, name: string, data: Uint8Array) {
  if (rel.split('/').some((part) => part === '..' || part.startsWith('.'))) throw new AgentError('Invalid folder', 400)
  const { real } = inside(root, rel)
  if (!lstatSync(real).isDirectory()) throw new AgentError('Not a folder', 400)
  const file = basename(name.replace(/\\/g, '/')).trim()
  if (!file || file.startsWith('.') || file.length > 200 || file.includes('\0')) throw new AgentError('Give the file a normal name')
  if (!data.byteLength) throw new AgentError(`${file} is empty`)
  if (data.byteLength > UPLOAD_MAX) throw new AgentError(`${file} is bigger than ${UPLOAD_MAX / 1024 / 1024} MB`, 413)
  const path = join(real, file)
  let fd: number
  try {
    // new only (never over a file, never through a link); 0664: the agents (another user on the VPS) can edit it too
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o664)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new AgentError(`${file} is already there: rename it first`, 409)
    throw e
  }
  try {
    writeSync(fd, data)
  } finally {
    closeSync(fd)
  }
  return { name: file, size: data.byteLength }
}

/**
 * A new, empty file in the folder on screen (the Files browser), any name and extension (dotfiles too: .env,
 * .prettierrc). Never over something that's there, never inside .git or over a file the office manages.
 */
export function addEmptyFile(root: string, rel: string, name: string) {
  if (rel.split('/').some((part) => part === '..')) throw new AgentError('Invalid folder', 400)
  const { real } = inside(root, rel)
  if (!lstatSync(real).isDirectory()) throw new AgentError('Not a folder', 400)
  const file = name.trim()
  if (!file || file === '.' || file === '..' || file.length > 200 || /[/\\\0]/.test(file)) throw new AgentError('Give the file a plain name (no slashes)')
  const relFile = [...rel.split('/').filter(Boolean), file].join('/')
  if (keptByOffice(relFile)) throw new AgentError('The office manages files there: not here', 403)
  let fd: number
  try {
    // 0664: the agents (another user on the VPS) can edit it too
    fd = openSync(join(real, file), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o664)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new AgentError(`${file} is already there`, 409)
    throw e
  }
  closeSync(fd)
  return { name: file, path: relFile }
}

/** A new, empty folder inside the folder on screen (the Files browser): a plain name, never over anything there. */
export function addFolder(root: string, rel: string, name: string) {
  if (rel.split('/').some((part) => part === '..' || part.startsWith('.'))) throw new AgentError('Invalid folder', 400)
  const { real } = inside(root, rel)
  if (!lstatSync(real).isDirectory()) throw new AgentError('Not a folder', 400)
  const dir = name.trim()
  if (!dir || dir.startsWith('.') || dir.length > 120 || /[/\\\0]/.test(dir)) throw new AgentError('Give the folder a plain name (no slashes, not starting with a dot)')
  try {
    // 0775: the agents (another user on the VPS) can add to it too
    mkdirSync(join(real, dir), { mode: 0o775 })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new AgentError(`${dir} is already there`, 409)
    throw e
  }
  return { name: dir }
}

export function folderFile(root: string, rel: string) {
  const { real } = inside(root, rel)
  const st = lstatSync(join(allowed(root), rel))
  if (st.isSymbolicLink() || !st.isFile()) throw new AgentError('Not a file', 400)
  if (st.size > MAX_BYTES) throw new AgentError('Too big to open here', 413)
  return { real, size: st.size }
}

const ZIP_MAX_FILES = 2000
const ZIP_MAX_BYTES = 300 * 1024 * 1024

/**
 * Several files and folders inside `root` as one ZIP (folders with what's in them). The same rules as browsing:
 * nothing outside `root`, no symlinks, no hidden files; limited in count and size.
 */
export function zipFromFolder(root: string, rels: string[]) {
  const base = allowed(root)
  if (!rels.length || rels.length > 500) throw new AgentError('Choose between 1 and 500 items', 400)
  const entries: ZipEntry[] = []
  let bytes = 0
  const add = (real: string) => {
    const st = lstatSync(real)
    if (st.isSymbolicLink()) return
    if (st.isDirectory()) {
      for (const d of readdirSync(real)) if (!d.startsWith('.')) add(join(real, d))
      return
    }
    if (!st.isFile()) return
    if (entries.length >= ZIP_MAX_FILES) throw new AgentError(`Too many files for one download (max ${ZIP_MAX_FILES})`, 413)
    bytes += st.size
    if (bytes > ZIP_MAX_BYTES) throw new AgentError('Too much for one download (max 300 MB); pick fewer files', 413)
    entries.push({ name: real.slice(base.length + 1), data: readFileSync(real), modified: st.mtime })
  }
  for (const rel of rels) {
    if (rel.split('/').some((part) => part.startsWith('.'))) throw new AgentError('Hidden files are not downloadable here', 403)
    const { real } = inside(root, rel)
    if (real === base) throw new AgentError('Pick files or folders inside it', 400)
    if (lstatSync(join(base, rel)).isSymbolicLink()) throw new AgentError('Links are not followed', 403)
    add(real)
  }
  if (!entries.length) throw new AgentError('Nothing to download there', 400)
  return { data: zip(entries), name: `${basename(base)}.zip`, files: entries.length }
}

/** Delete a folder whose agent is gone (only those: never an agent's, or anything outside). */
export async function deleteOrphanFolder(path: string) {
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    throw new AgentError('No such folder', 404)
  }
  if (!orphanFolders().includes(real)) throw new AgentError('Only folders without an agent can be deleted here', 403)
  await deleteAgentFolder(real)
  cache = null
}
