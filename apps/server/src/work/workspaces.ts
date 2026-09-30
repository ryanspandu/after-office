import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { zip, type ZipEntry } from './zip'
import type { FolderEntry, FolderListing } from '@after-office/shared'
import { IMAGE, MAX_BYTES } from '../agents/files'
import { deleteAgentFolder } from './projectFolders'
import { basename, extname, join, sep } from 'node:path'
import type { GitCommit, GitInfo, Workspace, WorkspaceFolder } from '@after-office/shared'
import { agentsRepo, extraDirsOf, projectsRepo } from '../db'
import { AgentError } from '../agents/errors'
import { AGENTS_DIR, PROJECTS_DIR } from '../fsroots'
import { git } from './git'

// The Projects tab: what the agents are working on, read from their folders. An agent's folder that is a git repo
// is one project; any other folder is a home for several, one per subfolder. Git runs with the agents' rights and
// safe flags (work/git.ts); nothing here writes anything.

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
  // which dashboard project each folder belongs to
  const linked = new Map<string, string>()
  for (const p of projectsRepo.all()) {
    if (!p.folder) continue
    try {
      linked.set(realpathSync(p.folder), p.id)
    } catch {
      // folder gone
    }
  }
  const link = <T extends WorkspaceFolder>(f: T): T => {
    try {
      return { ...f, projectId: linked.get(realpathSync(f.path)) ?? null }
    } catch {
      return { ...f, projectId: null }
    }
  }
  const byPath = new Map<string, string[]>()
  for (const a of agentsRepo.all()) byPath.set(a.cwd, [...(byPath.get(a.cwd) ?? []), a.id])
  const data = await Promise.all(
    [...byPath].map(async ([path, agentIds]) => {
      const self = await folder(path)
      // a repo or a project folder is one project; any other folder (an agent's home) holds several
      const isProject = !!self.git || isProjectRoot(path)
      const projects = isProject ? [] : await Promise.all(subfolders(path).map(folder))
      projects.sort((a, b) => b.updatedAt - a.updatedAt)
      return link({ ...self, agentIds, isProject, projects: projects.map(link) })
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
    data.push(link({ ...self, agentIds: [], isProject, orphan: true, projects: projects.map(link) }))
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
    data.push(link({ ...self, name: 'project', agentIds, isProject: false, shared: true, projects: projects.map(link) }))
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
  for (const root of [PROJECTS_DIR, ...orphanFolders()]) {
    if (real === root) return real
    if (real.startsWith(root + sep) && !real.slice(root.length + 1).includes(sep) && !lstatSync(path).isSymbolicLink()) return real
  }
  for (const a of agentsRepo.all()) {
    let root: string
    try {
      root = realpathSync(a.cwd)
    } catch {
      continue
    }
    if (real === root) return real
    if (real.startsWith(root + sep) && !real.slice(root.length + 1).includes(sep) && !lstatSync(path).isSymbolicLink()) return real
  }
  throw new AgentError('Not an agent folder', 403)
}

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

/** The entries of a folder inside `root`: folders first, hidden ones (.git, .claude…) left out. */
export function listFolder(root: string, rel = ''): FolderListing {
  const { base, real } = inside(root, rel)
  if (!lstatSync(real).isDirectory()) throw new AgentError('Not a folder', 400)
  const entries: FolderEntry[] = []
  let total = 0
  for (const d of readdirSync(real, { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue
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

/** A file inside `root` for preview / download: a real file (no symlink), not too big. */
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

/** Delete a folder whose agent is gone (only those: never an agent's, a project's, or anything outside). */
export async function deleteOrphanFolder(path: string) {
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    throw new AgentError('No such folder', 404)
  }
  if (!orphanFolders().includes(real)) throw new AgentError('Only folders without an agent can be deleted here', 403)
  if (projectsRepo.all().some((p) => p.folder && (p.folder === real || p.folder.startsWith(real + sep))))
    throw new AgentError('A project uses this folder; change or delete the project first', 409)
  await deleteAgentFolder(real)
  cache = null
}
