import { useEffect, useState } from 'react'
import { LuPower, LuRotateCw, LuTriangleAlert } from 'react-icons/lu'
import { liveApi } from '../../state/live'
import type { OfficeAgent } from '../../state/store'
import { confirm } from '../Confirm'

// Shown in an offline agent's chat: restart just this agent, or all of them (their tmux server). The second is for
// a tmux server that can't start sessions any more (its working folder went away, e.g. the drive was remounted):
// every agent restarted in it exits right away, so the office keeps showing them offline.

export function OfflineBanner({ agent }: { agent: OfficeAgent }) {
  const [health, setHealth] = useState<{ canStartSessions: boolean; isolated: boolean } | null>(null)
  const [busy, setBusy] = useState<'' | 'one' | 'all'>('')
  const [error, setError] = useState('')

  // how's the tmux server? (checked when it goes offline, and again every 15 s while it stays offline)
  useEffect(() => {
    let alive = true
    const check = () => liveApi.agentServer().then((h) => alive && setHealth(h), () => {})
    void check()
    const id = setInterval(check, 15_000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [agent.id])

  const run = async (which: 'one' | 'all', fn: () => Promise<unknown>) => {
    setBusy(which)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restart failed')
    } finally {
      setBusy('')
    }
  }
  const restartAll = async () => {
    const ok = await confirm({
      title: 'Restart all agents?',
      message: "Every agent's session stops and starts again, resuming its conversation. Anything they're in the middle of is interrupted, and text typed in their terminals but not sent is lost.",
      confirmLabel: 'Restart all',
    })
    if (ok) await run('all', () => liveApi.restartAgentServer())
  }
  const broken = health && !health.canStartSessions

  return (
    <div className={`offline-banner${broken ? ' offline-banner--broken' : ''}`} role="status">
      <span className="offline-banner__icon">{broken ? <LuTriangleAlert /> : <LuPower />}</span>
      <div className="offline-banner__text">
        <b>{agent.name} is offline.</b>{' '}
        {broken
          ? health.isolated
            ? "The agents' tmux server can't start sessions. On the server run: sudo systemctl restart after-office-agents"
            : "The agents' tmux server can't start sessions any more (its folder went away), so restarts fail. Restart all agents to fix it."
          : 'It usually comes back on its own in a few seconds.'}
        {error && <span className="danger-text"> {error}</span>}
      </div>
      <div className="offline-banner__actions">
        <button className="small" disabled={!!busy} onClick={() => run('one', () => liveApi.restart(agent.id))}>
          <LuRotateCw className={busy === 'one' ? 'spin' : ''} /> Restart session
        </button>
        {!health?.isolated && (
          <button className={`small${broken ? ' primary' : ''}`} disabled={!!busy} onClick={restartAll} data-tip="Restart the agents' tmux server: every agent resumes its conversation">
            <LuRotateCw className={busy === 'all' ? 'spin' : ''} /> Restart all agents
          </button>
        )}
      </div>
    </div>
  )
}
