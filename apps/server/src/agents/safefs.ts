import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeSync } from 'node:fs'
import { dirname, sep } from 'node:path'
import { AgentError } from './errors'

// Reading and writing the dashboard's files inside an agent's folder (settings, .mcp.json, CLAUDE.md, skills).
// The folder belongs to the agent, which could have swapped any of these for a symlink (to ~/.bashrc, the
// dashboard's .env, …). So: the file must really be inside the folder, and a symlink is never followed.

function inside(folder: string, dir: string) {
  const root = realpathSync(folder)
  const real = realpathSync(dir)
  if (real !== root && !real.startsWith(root + sep)) throw new AgentError(`${dir} leads outside the agent's folder`, 409)
}

export function writeInFolder(folder: string, path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  inside(folder, dirname(path))
  try {
    if (!lstatSync(path).isFile()) throw new AgentError(`${path} is not a regular file; not overwriting it`, 409)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  // 0664: in the hardened setup the agent (another user, via ACLs) edits these too, e.g. "always allow" rules
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o664)
  try {
    writeSync(fd, content)
  } finally {
    closeSync(fd)
  }
}

/** The file's text, or null when it doesn't exist or isn't a plain file inside the folder. */
export function readInFolder(folder: string, path: string, max = 1_000_000): string | null {
  try {
    if (!lstatSync(path).isFile()) return null
    inside(folder, dirname(path))
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const size = Math.min(fstatSync(fd).size, max)
      const buf = Buffer.alloc(size)
      return buf.subarray(0, readSync(fd, buf, 0, size, 0)).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}
