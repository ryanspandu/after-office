import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { agentEnv, ISOLATED } from './env'
import { tmuxCmd } from './tmux'

// Commands that touch an agent's folder (quality checks, git for the Changes view) run with the agent's rights, not
// the dashboard's: a repo can make git run programs (hooks, fsmonitor, textconv/filters in its config), and a check
// runs the project's own code. In the hardened setup (OFFICE_TMUX_SOCKET) agents are another Unix user, so these go
// through the agents' tmux server (`run-shell`, which runs as that user). Otherwise they are plain child processes.

export interface AgentRun {
  code: number
  out: string
  timedOut: boolean
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const MAX_OUT = 2_000_000

export async function runAsAgent(argv: string[], opts: { cwd: string; timeoutMs: number; mergeStderr?: boolean }): Promise<AgentRun> {
  return ISOLATED ? viaTmux(argv, opts) : direct(argv, opts)
}

async function direct(argv: string[], { cwd, timeoutMs, mergeStderr }: { cwd: string; timeoutMs: number; mergeStderr?: boolean }): Promise<AgentRun> {
  const p = Bun.spawn(mergeStderr ? ['sh', '-c', `${argv.map(q).join(' ')} 2>&1`] : argv, {
    cwd,
    stdout: 'pipe',
    stderr: 'ignore',
    env: agentEnv(),
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    // children (test runners, sleeps…) hold the pipe open: stop them too
    Bun.spawnSync(['pkill', '-KILL', '-P', String(p.pid)])
    p.kill('SIGKILL')
  }, timeoutMs)
  let out = ''
  const reader = p.stdout.getReader()
  const decoder = new TextDecoder()
  const read = (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (out.length < MAX_OUT) out += decoder.decode(value, { stream: true })
    }
  })()
  const code = await p.exited
  // don't wait for orphans that still hold the pipe after a timeout
  await Promise.race([read, Bun.sleep(timedOut ? 200 : 5000)])
  clearTimeout(timer)
  return { code: timedOut ? 124 : code, out, timedOut }
}

/** Where job output lands: next to the agents' tmux socket (their runtime dir, readable by the dashboard's group). */
const JOBS = () => process.env.OFFICE_AGENT_JOBS || join(dirname(process.env.OFFICE_TMUX_SOCKET!), 'jobs')

async function viaTmux(argv: string[], { cwd, timeoutMs, mergeStderr }: { cwd: string; timeoutMs: number; mergeStderr?: boolean }): Promise<AgentRun> {
  const secs = Math.max(1, Math.ceil(timeoutMs / 1000))
  const job = join(JOBS(), crypto.randomUUID())
  // run-shell (without -b) returns when the command is done; its output would go to a pane, so it goes to files
  const shell = [
    `mkdir -p ${q(JOBS())}`,
    `(cd ${q(cwd)} && exec timeout -k 5 ${secs} ${argv.map(q).join(' ')}) > ${q(`${job}.out`)} ${mergeStderr ? '2>&1' : '2>/dev/null'}`,
    `echo $? > ${q(`${job}.rc`)}`,
  ].join('; ')
  // run-shell expands #{formats}: double every # so commands arrive as written
  const p = Bun.spawn(tmuxCmd('run-shell', shell.replace(/#/g, '##')), { stdout: 'ignore', stderr: 'ignore', env: agentEnv() })
  await p.exited
  // the job folder is the agent's: read only plain files really in it (no symlink to the dashboard's data)
  const read = (f: string) => {
    try {
      if (realpathSync(dirname(f)) !== realpathSync(JOBS())) return ''
      if (!lstatSync(f).isFile()) return ''
      const fd = openSync(f, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const size = Math.min(fstatSync(fd).size, MAX_OUT)
        const buf = Buffer.alloc(size)
        return buf.subarray(0, readSync(fd, buf, 0, size, 0)).toString('utf8')
      } finally {
        closeSync(fd)
      }
    } catch {
      return ''
    }
  }
  const rc = read(`${job}.rc`).trim()
  const out = read(`${job}.out`)
  // the files belong to the agent user: it removes them
  Bun.spawn(tmuxCmd('run-shell', '-b', `rm -f ${q(`${job}.out`)} ${q(`${job}.rc`)}`), { stdout: 'ignore', stderr: 'ignore', env: agentEnv() })
  const code = rc === '' ? 1 : Number(rc)
  return { code, out, timedOut: code === 124 || code === 137 }
}
