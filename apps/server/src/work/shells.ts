import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { ISOLATED } from '../agents/env'
import { AgentError } from '../agents/errors'
import { tmux } from '../agents/tmux'
import { folderOf } from './workspaces'

// A terminal in a folder (the folder details' Terminal): a plain shell in the agents' tmux server, so it runs with the
// agents' rights (on a server their own Unix user: no root, no sudo, nothing of the dashboard's). One per folder; it
// keeps running when the browser goes away (a dev server started in it stays up) until it's ended. Opening one asks
// for the authenticator code (routes): a stolen dashboard session alone gives no shell.

/** Its tmux session: "ao--sh-…" can't be an agent's name (an agent's slug never has "--"). */
export const shellName = (folder: string) => `ao--sh-${createHash('sha256').update(folder).digest('hex').slice(0, 12)}`

/** The shell to run: a login shell (the agents' bash on a server; the owner's own shell locally). */
function shellCommand() {
  if (!ISOLATED && process.env.SHELL && existsSync(process.env.SHELL)) return [process.env.SHELL, '-l']
  return existsSync('/bin/bash') ? ['/bin/bash', '-l'] : ['/bin/sh', '-l']
}

/** Is the folder's shell running? */
export async function shellRunning(root: string) {
  return tmux.hasSession(shellName(folderOf(root)))
}

/** Start the folder's shell (or keep the one that's running). */
export async function openShell(root: string) {
  const folder = folderOf(root)
  const name = shellName(folder)
  if (await tmux.hasSession(name)) return { name, started: false }
  if (!(await tmux.available())) throw new AgentError('tmux is not installed on the server', 500)
  await tmux.newSession({ name, cwd: folder, env: { AO_SHELL: '1' }, command: shellCommand() })
  return { name, started: true }
}

/** End it: the shell and everything still running in it stop. */
export async function endShell(root: string) {
  const name = shellName(folderOf(root))
  if (await tmux.hasSession(name)) await tmux.killSession(name)
  return { ended: true }
}

/** The tmux session to attach the browser to: only a folder's shell that is running (opened with the code). */
export async function shellTarget(root: string) {
  const name = shellName(folderOf(root))
  if (!(await tmux.hasSession(name))) throw new AgentError('Open the terminal first', 409)
  return name
}
