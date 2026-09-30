import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { LuCrown, LuMessageSquare, LuUsers, LuX } from 'react-icons/lu'
import { create } from 'zustand'
import { divisionOf } from '@after-office/shared'
import { useNow } from '../state/clock'
import { useDashboard } from '../state/dashboard'
import { useOffice, type OfficeAgent, avatarStyle } from '../state/store'
import { ChatTab } from './agent/ChatTab'
import { openUrl, setUrl, useParam } from '../state/url'
import { MaximizeButton, useMaximize } from './Maximize'
import { ago } from './FollowUps'
import { STATUS_BY_ID } from './taskMeta'

// The manager's own panel: talk to it (Chat) and see what it handed out (Team). Opened from the navbar on desktops
// and from the dock on phones. The manager is a normal Claude Code agent with the after-office MCP tools.

export const useManagerPanel = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

/** The office manager, if there is one (live mode). */
export function useManager(): OfficeAgent | undefined {
  return useOffice((s) => (s.source === 'live' ? s.agents.find((a) => a.kind === 'manager') : undefined))
}

export function ManagerPanel() {
  const open = useManagerPanel((s) => s.open)
  const setOpen = useManagerPanel((s) => s.setOpen)
  const manager = useManager()
  if (!open || !manager) return null
  return createPortal(<Panel key={manager.id} manager={manager} onClose={() => setOpen(false)} />, document.body)
}

function Panel({ manager, onClose: close }: { manager: OfficeAgent; onClose: () => void }) {
  // the tab is in the address bar too (?manager=1&mtab=team)
  const tab: 'chat' | 'team' = useParam('mtab') === 'team' ? 'team' : 'chat'
  const setTab = (t: 'chat' | 'team') => setUrl({ mtab: t === 'chat' ? null : t })
  const max = useMaximize('ao-max-manager')
  const [closing, setClosing] = useState(false)
  const onClose = useCallback(() => {
    setClosing(true)
    setTimeout(close, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220)
  }, [close])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('.chat, .modal') && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const tasks = useDashboard((s) => s.tasks)
  const delegated = useMemo(() => tasks.filter((t) => t.delegatedBy === manager.id), [tasks, manager.id])
  const open = delegated.filter((t) => t.status !== 'done').length

  return (
    <div className={`drawer-backdrop${closing ? ' drawer-backdrop--closing' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={max.ref} className={`drawer drawer--wide${max.full ? ' drawer--full' : ''}`} role="dialog" aria-modal="true" aria-label="Manager">
        <header className="drawer__head">
          <span className="avatar avatar--lg manager-avatar" style={avatarStyle(manager.look.shirt)}>
            <LuCrown />
          </span>
          <div className="drawer__title">
            <h3>
              {manager.name}
              <span className={`status status--${manager.status}`}>{manager.status}</span>
            </h3>
            <p className="muted">{manager.role || 'General Manager'} · runs every division and reports back here</p>
          </div>
          <MaximizeButton full={max.full} onToggle={max.toggle} />
          <button className="icon-btn small ghost" data-tip="Close" aria-label="Close" onClick={onClose}>
            <LuX />
          </button>
        </header>

        <nav className="drawer__tabs seg">
          <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>
            <LuMessageSquare /> Chat
            {!!manager.unread && tab !== 'chat' && <span className="seg__count">{manager.unread}</span>}
          </button>
          <button className={tab === 'team' ? 'active' : ''} onClick={() => setTab('team')}>
            <LuUsers /> Team
            {open > 0 && <span className="seg__count">{open}</span>}
          </button>
        </nav>

        <div className={`drawer__body${tab === 'chat' ? ' drawer__body--flush' : ''}`}>
          {tab === 'chat' ? <ChatTab agent={manager} /> : <Team tasks={delegated} />}
        </div>
      </aside>
    </div>
  )
}

function Team({ tasks }: { tasks: ReturnType<typeof useDashboard.getState>['tasks'] }) {
  const agents = useOffice((s) => s.agents)
  const reports = useDashboard((s) => s.reports)
  const now = useNow(60_000).getTime()
  // newest first: tasks created later have a later start
  const sorted = [...tasks].sort((a, b) => (b.startedAt ?? b.deadline) - (a.startedAt ?? a.deadline))

  if (!sorted.length)
    return (
      <div className="empty">
        Nothing delegated yet. Tell the manager what you need in Chat; it picks the agents and hands out the tasks.
      </div>
    )

  return (
    <>
      <ul className="team-list">
        {sorted.map((t) => {
          const agent = agents.find((a) => a.id === t.agentId)
          const report = reports.find((r) => r.kind === 'task' && r.refId === t.id)
          const st = STATUS_BY_ID[t.status]
          return (
            <li key={t.id}>
              <button className="team-row" onClick={() => openUrl({ task: t.id })}>
                <span className="status-pill" style={{ ['--c' as string]: st.color }}>
                  {st.label}
                </span>
                <span className="team-row__body">
                  <span className="team-row__title truncate">{t.title}</span>
                  <span className="team-row__meta truncate">
                    {agent ? `${agent.name} · ${divisionOf(agent.role)}` : 'Removed agent'}
                    {report ? ` · reported ${ago(now - report.finishedAt)}${report.ok ? '' : ' (did not finish)'}` : t.status === 'in_progress' ? ' · working on it' : ''}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}
