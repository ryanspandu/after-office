import { useEffect } from 'react'
import type { CronJob } from '@after-office/shared'
import { api } from './auth'
import { useClock, zonedParts } from './clock'
import { useDashboard } from './dashboard'
import { useOffice } from './store'

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
/** Only catch up slots whose time passed within this many minutes (e.g. after the tab was asleep). */
const CATCH_UP_MIN = 5

/** "Run now". Live: the server types the prompt into the agent's session (or queues it while the agent is busy). */
export async function runCronNow(cron: CronJob): Promise<string> {
  if (useOffice.getState().source !== 'live') return runCron(cron) ? 'Sent' : 'No agent'
  const res = await api(`/api/crons/${cron.id}/run`, { method: 'POST' })
  const body = await res.json().catch(() => null)
  if (!res.ok) return body?.error ?? 'Failed'
  return body?.result === 'queued' ? 'Queued' : 'Sent'
}

/** Demo mode: pretend the agent picked it up. */
function runCron(cron: CronJob, slot?: string) {
  const { agents, setStatus } = useOffice.getState()
  const agent = agents.find((a) => a.id === cron.agentId)
  if (!agent) return false
  setStatus(agent.id, 'working', { task: `⏰ ${cron.name}`, tool: 'Bash' })
  if (slot) useDashboard.getState().updateCron(cron.id, { lastRuns: [...(cron.lastRuns ?? []), slot].slice(-50) })
  return true
}

/** Demo mode only: fires each (day, time) slot of every enabled job once, when the office clock reaches it.
 *  In live mode the server's scheduler does this, even with no dashboard open. */
export function useCronRunner() {
  const source = useOffice((s) => s.source)
  useEffect(() => {
    if (source === 'live') return
    const tick = () => {
      const { hhmm, date, weekday } = zonedParts(new Date(), useClock.getState().timezone)
      const today = WEEKDAY_INDEX[weekday]
      const [nh, nm] = hhmm.split(':').map(Number)
      const nowMin = nh * 60 + nm
      for (const cron of useDashboard.getState().crons) {
        if (!cron.enabled || !cron.days.includes(today)) continue
        for (const time of cron.times) {
          const [h, m] = time.split(':').map(Number)
          const late = nowMin - (h * 60 + m)
          const slot = `${date} ${time}`
          if (late < 0 || late > CATCH_UP_MIN || cron.lastRuns?.includes(slot)) continue
          runCron(cron, slot)
        }
      }
    }
    tick()
    const id = setInterval(tick, 15_000)
    return () => clearInterval(id)
  }, [source])
}

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "Every day", "Weekdays", "Weekends" or "Mon, Wed, Fri". */
export function describeDays(days: number[]) {
  const set = [...new Set(days)].sort()
  if (set.length === 7) return 'Every day'
  if (set.join() === '1,2,3,4,5') return 'Weekdays'
  if (set.join() === '0,6') return 'Weekends'
  if (!set.length) return 'Never'
  // Monday-first order reads more naturally
  return [...set].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_SHORT[d]).join(', ')
}
