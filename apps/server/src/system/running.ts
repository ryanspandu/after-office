import { realpathSync, statfsSync } from 'node:fs'
import { agentsRepo, sideSessionsRepo } from '../db'
import { runAsAgent } from '../agents/asagent'
import { runtimeOf, sideRuntimeOf } from '../agents/registry'
import { tmux } from '../agents/tmux'
import { AGENT_HOME, AGENTS_DIR } from '../fsroots'
import { HOME_SHELL, shellName } from '../work/shells'
import { workspaces } from '../work/workspaces'

// The Server window's Running tab: what is up on the server for the office. The agents' Claude Code sessions (and
// which should be but aren't), the folder terminals that are open, and the programs the agents' user runs that listen
// on a port (dev servers, previews, databases started by an agent), each with how long it has been up and where.

export interface RunningReport {
  sessions: { agentId: string; agent: string; session: string; status: string; alive: boolean; compacting: boolean }[]
  terminals: { name: string; folder: string | null }[]
  services: { port: number; pid: number; command: string; args: string; cwd: string | null; upSec: number | null; /** runs in one of the office's folders (else: something else of the same user) */ inOffice: boolean }[]
  disk: { totalGb: number; freeGb: number; path: string } | null
  checkedAt: number
}

const DASHBOARD_PORT = Number(process.env.OFFICE_PORT ?? process.env.PORT ?? 8787)

/** Who listens on which TCP port, among the processes the agents' user can see: lsof, else ss. */
async function listeners(): Promise<{ port: number; pid: number; command: string }[]> {
  const script = [
    'if command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP -sTCP:LISTEN -Fpcn 2>/dev/null',
    // ss: "LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=123,fd=21))"
    `else ss -ltnpH 2>/dev/null | sed -n 's/.*:\\([0-9]*\\) .*users:((\\"\\([^\\"]*\\)\\",pid=\\([0-9]*\\).*/ss \\1 \\2 \\3/p'; fi`,
  ].join('; ')
  const r = await runAsAgent(['sh', '-c', script], { cwd: AGENTS_DIR, timeoutMs: 8000 }).catch(() => ({ out: '' }))
  const out: { port: number; pid: number; command: string }[] = []
  let pid = 0
  let command = ''
  for (const line of r.out.split('\n')) {
    if (line.startsWith('ss ')) {
      const [, port, cmd, p] = line.split(' ')
      out.push({ port: Number(port), pid: Number(p), command: cmd })
    } else if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('c')) command = line.slice(1)
    else if (line.startsWith('n')) {
      const port = Number(line.slice(line.lastIndexOf(':') + 1))
      if (port) out.push({ port, pid, command })
    }
  }
  // one row per port (IPv4 and IPv6 both listed); never the dashboard itself
  const seen = new Set<number>()
  return out.filter((l) => l.pid > 1 && l.pid !== process.pid && l.port !== DASHBOARD_PORT && !seen.has(l.port) && seen.add(l.port))
}

/** Each process's full command line, how long it has run, and its folder. */
async function details(pids: number[]) {
  const info = new Map<number, { args: string; upSec: number | null; cwd: string | null }>()
  if (!pids.length) return info
  const list = pids.join(',')
  const script = [
    `ps -o pid=,etimes=,args= -p ${list} 2>/dev/null || ps -o pid=,etime=,command= -p ${list} 2>/dev/null`,
    'echo "--cwd--"',
    `for p in ${pids.join(' ')}; do d=$(readlink /proc/$p/cwd 2>/dev/null || lsof -a -p $p -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'); echo "$p $d"; done`,
  ].join('; ')
  const r = await runAsAgent(['sh', '-c', script], { cwd: AGENTS_DIR, timeoutMs: 8000 }).catch(() => ({ out: '' }))
  const [ps, cwds = ''] = r.out.split('--cwd--')
  const secs = (t: string) => {
    if (/^\d+$/.test(t)) return Number(t)
    // [[dd-]hh:]mm:ss
    const [days, rest] = t.includes('-') ? t.split('-') : ['0', t]
    const parts = rest.split(':').map(Number)
    while (parts.length < 3) parts.unshift(0)
    return Number(days) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]
  }
  for (const line of ps.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^(\d+)\s+(\S+)\s+(.*)$/)
    if (m) info.set(Number(m[1]), { args: m[3].slice(0, 300), upSec: secs(m[2]), cwd: null })
  }
  for (const line of cwds.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [p, ...rest] = line.split(' ')
    const cwd = rest.join(' ').trim()
    const row = info.get(Number(p))
    if (row && cwd) row.cwd = cwd
  }
  return info
}

function disk() {
  try {
    const s = statfsSync(AGENT_HOME)
    const gb = (n: number) => Math.round((n / 1024 ** 3) * 10) / 10
    return { totalGb: gb(s.blocks * s.bsize), freeGb: gb(s.bavail * s.bsize), path: AGENT_HOME }
  } catch {
    return null
  }
}

export async function runningReport(): Promise<RunningReport> {
  const live = new Set(await tmux.listSessions())
  const sessions: RunningReport['sessions'] = []
  for (const a of agentsRepo.all()) {
    const rt = runtimeOf(a.id)
    sessions.push({ agentId: a.id, agent: a.name, session: 'Main', status: rt.status, alive: live.has(a.tmux_session), compacting: !!rt.compactingSince })
    for (const s of sideSessionsRepo.forAgent(a.id).filter((s) => !s.closed_at)) {
      const srt = sideRuntimeOf(a.id, s.key)
      sessions.push({ agentId: a.id, agent: a.name, session: s.name ?? s.title ?? s.key, status: srt.status, alive: live.has(s.tmux_session), compacting: !!srt.compactingSince })
    }
  }
  // a terminal's tmux name comes from its folder (a hash): matched against the folders the office knows
  const folders = new Map<string, string>()
  for (const w of await workspaces().catch(() => [])) {
    folders.set(shellName(w.path), w.path)
    for (const p of w.projects) folders.set(shellName(p.path), p.path)
  }
  // the agents' home terminal (the Server window's own)
  let home: string | null = null
  try {
    home = realpathSync(AGENT_HOME)
  } catch {
    home = null
  }
  const terminals = [...live]
    .filter((n) => n.startsWith('ao--sh-'))
    .map((name) => ({ name, folder: home && name === shellName(home) ? HOME_SHELL : (folders.get(name) ?? null) }))
  const ports = await listeners()
  const info = await details([...new Set(ports.map((p) => p.pid))])
  const roots = [AGENTS_DIR, ...folders.values()]
  const inOffice = (cwd: string | null) => !!cwd && roots.some((r) => cwd === r || cwd.startsWith(`${r}/`))
  const services = ports
    .map((p) => {
      const cwd = info.get(p.pid)?.cwd ?? null
      return { ...p, args: info.get(p.pid)?.args ?? p.command, cwd, upSec: info.get(p.pid)?.upSec ?? null, inOffice: inOffice(cwd) }
    })
    .sort((a, b) => Number(b.inOffice) - Number(a.inOffice) || a.port - b.port)
  return { sessions, terminals, services, disk: disk(), checkedAt: Date.now() }
}

/** End a folder terminal by its tmux name (one of ours only). */
export async function endTerminal(name: string) {
  if (!/^ao--sh-[0-9a-f]{12}$/.test(name)) throw new Error('Not a terminal')
  if (await tmux.hasSession(name)) await tmux.killSession(name)
  return { ended: true }
}
