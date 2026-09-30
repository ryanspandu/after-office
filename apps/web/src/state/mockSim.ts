import { useEffect } from 'react'
import type { AgentStatus } from '@after-office/shared'
import { useDashboard, ymd } from './dashboard'
import { useOffice } from './store'

// Fake agent activity so the office feels alive before real hook data is wired in (Phase 2).

const TASKS = [
  ['Refactor auth middleware', 'Edit'],
  ['Write tests for /api/users', 'Write'],
  ['Fix flaky e2e checkout test', 'Bash'],
  ['Migrate db schema to v4', 'Bash'],
  ['Read through payment service', 'Read'],
  ['Search for unused exports', 'Grep'],
  ['Update README install steps', 'Edit'],
  ['Bump deps & fix types', 'Bash'],
  ['Profile slow dashboard query', 'Read'],
] as const

const ASKS = ['Allow `git push --force`?', 'Allow `rm -rf node_modules`?', 'Which DB should I use?', 'Allow network access?']

const rand = <T,>(arr: readonly T[]) => arr[Math.floor(Math.random() * arr.length)]

function nextStatus(): AgentStatus {
  const r = Math.random()
  if (r < 0.5) return 'working'
  if (r < 0.8) return 'idle'
  if (r < 0.9) return 'waiting'
  return 'meeting'
}

export function useMockSim() {
  const simOn = useOffice((s) => s.simOn && s.source === 'demo')

  useEffect(() => {
    if (!simOn) return
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      const { agents, setStatus, startMeeting } = useOffice.getState()
      if (agents.length) {
        const inMeeting = agents.filter((a) => a.status === 'meeting')
        if (inMeeting.length && Math.random() < 0.35) {
          // meeting's over, everyone back to work
          for (const a of inMeeting) {
            const [task, tool] = rand(TASKS)
            setStatus(a.id, 'working', { task, tool })
          }
        } else if (!inMeeting.length && Math.random() < 0.12) {
          const ids = [...agents].sort(() => Math.random() - 0.5).slice(0, 2 + Math.floor(Math.random() * 3))
          startMeeting(ids.map((a) => a.id))
        } else {
          const a = rand(agents.filter((a) => a.status !== 'meeting').length ? agents.filter((a) => a.status !== 'meeting') : agents)
          const status = nextStatus()
          if (status === 'working') {
            const [task, tool] = rand(TASKS)
            setStatus(a.id, status, { task, tool })
          } else if (status === 'waiting') setStatus(a.id, status, { task: rand(ASKS), tool: 'Bash' })
          else if (status === 'meeting') startMeeting([a.id])
          else setStatus(a.id, status, { task: undefined, tool: undefined })
        }
      }
      timer = setTimeout(tick, 2500 + Math.random() * 4000)
    }
    timer = setTimeout(tick, 2500)
    return () => clearTimeout(timer)
  }, [simOn])
}

/** Wobbling CPU/RAM numbers, and today's token counter growing while agents work. */
export function useMetricsSim() {
  const demo = useOffice((s) => s.source === 'demo')
  useEffect(() => {
    if (!demo) return
    const id = setInterval(() => {
      const { metrics, setMetrics } = useDashboard.getState()
      const working = useOffice.getState().agents.filter((a) => a.status === 'working').length
      const target = 12 + working * 9
      setMetrics({
        ...metrics,
        cpu: Math.max(3, Math.min(99, metrics.cpu + (target - metrics.cpu) * 0.2 + (Math.random() - 0.5) * 8)),
        memUsedGb: Math.max(2, Math.min(metrics.memTotalGb - 0.5, 3.2 + working * 0.55 + (Math.random() - 0.5) * 0.3)),
      })
      if (!working) return
      const date = ymd(new Date())
      useDashboard.setState((s) => {
        const usage = [...s.usage]
        for (const a of useOffice.getState().agents.filter((a) => a.status === 'working')) {
          const i = usage.findIndex((u) => u.date === date && u.agentId === a.id)
          const add = { input: Math.round(800 + Math.random() * 2400), output: Math.round(200 + Math.random() * 600) }
          if (i === -1) usage.push({ date, agentId: a.id, ...add })
          else usage[i] = { ...usage[i], input: usage[i].input + add.input, output: usage[i].output + add.output }
        }
        return { usage }
      })
    }, 2000)
    return () => clearInterval(id)
  }, [demo])
}
