import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { runAsAgent } from '../agents/asagent'
import type { DiffFile, OfficeTask, TaskDiff } from '@after-office/shared'

// The "Changes" view of a task: what the agent changed in its folder since the task was handed over. Read-only: a
// snapshot is `git stash create` (a commit object of the working tree that touches neither the index, the stash list
// nor any file) or HEAD when the tree is clean, plus the list of untracked files at that moment.

const MAX_TOTAL = 400_000
const MAX_NEW_FILE = 100_000

// A repo's own config can make git run programs; switch off what these read-only commands could trigger.
const SAFE = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.pager=cat',
  '-c', 'diff.external=',
  '-c', 'protocol.allow=never',
  // never take the index lock: the agent may be using git at the same time
  '-c', 'core.optionalLocks=false',
]

export async function git(cwd: string, args: string[]) {
  try {
    // with the agent's rights (see agents/asagent.ts)
    const r = await runAsAgent(['git', ...SAFE, '-C', cwd, ...args], { cwd, timeoutMs: 20_000 })
    return { ok: r.code === 0, out: r.out }
  } catch {
    return { ok: false, out: '' }
  }
}

export async function snapshot(cwd: string): Promise<OfficeTask['gitBase'] | undefined> {
  if (!(await git(cwd, ['rev-parse', '--is-inside-work-tree'])).ok) return undefined
  const stash = (await git(cwd, ['stash', 'create'])).out.trim()
  const ref = stash || (await git(cwd, ['rev-parse', '--verify', 'HEAD'])).out.trim()
  if (!ref) return undefined // a repo without commits: nothing to compare against
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).out.split('\0').filter(Boolean)
  return { ref, untracked: untracked.slice(0, 5000), at: Date.now() }
}

const STATUS: Record<string, DiffFile['status']> = { A: 'added', D: 'deleted', R: 'renamed', M: 'modified' }

/**
 * A new file's text, read safely: only a regular file (no symlink, device or pipe, which could leak a file from
 * elsewhere or hang the server), inside the folder, without following a final symlink, at most MAX_NEW_FILE bytes.
 * null: not a regular file; undefined: too large.
 */
function readNewFile(cwd: string, path: string): string | null | undefined {
  const full = join(cwd, path)
  try {
    if (!lstatSync(full).isFile()) return null
    const root = realpathSync(cwd)
    if (!realpathSync(full).startsWith(root + sep)) return null // a symlinked parent folder
    const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const st = fstatSync(fd)
      if (!st.isFile()) return null
      if (st.size > MAX_NEW_FILE) return undefined
      const buf = Buffer.alloc(st.size)
      const n = readSync(fd, buf, 0, st.size, 0)
      return buf.subarray(0, n).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

export async function diffSince(cwd: string, base: NonNullable<OfficeTask['gitBase']>): Promise<TaskDiff> {
  if (!(await git(cwd, ['cat-file', '-e', `${base.ref}^{commit}`])).ok) return { files: null, truncated: false, reason: 'The starting point is no longer in the repository.' }
  const [patch, numstat, names, untracked] = await Promise.all([
    git(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', base.ref]),
    git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--numstat', '-M', '-z', base.ref]),
    git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-M', '-z', base.ref]),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
  ])

  // path → status / counts
  const status = new Map<string, DiffFile['status']>()
  const n = names.out.split('\0')
  for (let i = 0; i < n.length - 1; ) {
    const code = n[i][0]
    if (code === 'R' || code === 'C') {
      status.set(n[i + 2], 'renamed')
      i += 3
    } else {
      status.set(n[i + 1], STATUS[code] ?? 'modified')
      i += 2
    }
  }
  const counts = new Map<string, [number, number]>()
  const ns = numstat.out.split('\0')
  for (let i = 0; i < ns.length; i++) {
    const m = ns[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/s)
    if (!m) continue
    let path = m[3]
    if (!path) {
      path = ns[i + 2] // rename: "a\tb\t" then old, new
      i += 2
    }
    counts.set(path, [m[1] === '-' ? 0 : Number(m[1]), m[2] === '-' ? 0 : Number(m[2])])
  }

  let truncated = false
  let total = 0
  const cut = (text: string) => {
    const room = MAX_TOTAL - total
    if (text.length > room) {
      truncated = true
      text = room > 0 ? `${text.slice(0, room)}\n… (cut)` : ''
    }
    total += text.length
    return text
  }

  const files: DiffFile[] = []
  const chunks = patch.out.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '))
  for (const chunk of chunks) {
    const header = chunk.slice(0, chunk.indexOf('\n'))
    const path = [...status.keys()].find((p) => header.endsWith(` b/${p}`)) ?? header.replace(/^diff --git a\/.* b\//, '')
    const [additions, deletions] = counts.get(path) ?? [0, 0]
    files.push({ path, status: status.get(path) ?? 'modified', additions, deletions, patch: cut(chunk) })
  }

  // files the agent created that git doesn't track yet
  const before = new Set(base.untracked)
  for (const path of untracked.out.split('\0').filter(Boolean)) {
    if (before.has(path)) continue
    let body = ''
    let lines = 0
    const text = readNewFile(cwd, path)
    if (text === null) body = '(not a regular file: not shown)'
    else if (text === undefined) body = '(file too large to show)'
    else if (text.includes('\0')) body = '(binary file)'
    else {
      const rows = text.split('\n')
      if (rows.at(-1) === '') rows.pop()
      lines = rows.length
      body = `@@ -0,0 +1,${lines} @@\n${rows.map((r) => `+${r}`).join('\n')}`
    }
    files.push({ path, status: 'added', additions: lines, deletions: 0, patch: cut(`diff --git a/${path} b/${path}\nnew file (untracked)\n${body}`) })
    if (files.length > 500) {
      truncated = true
      break
    }
  }
  return { files, truncated }
}
