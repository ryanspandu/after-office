import { haptic } from '../state/haptic'
import { useMemo, useState, type ReactNode, useEffect } from 'react'
import { LuBot, LuBriefcase, LuCalendarClock, LuCrown, LuFolderGit2, LuInbox, LuLibrary } from 'react-icons/lu'
import { useNow } from '../state/clock'
import { useDashboard } from '../state/dashboard'
import { unreadOf, useOffice } from '../state/store'
import { AgentsCard } from './AgentsPanel'
import { FollowUps, useAttentionCount } from './FollowUps'
import { CronPanel, TaskPanel } from './LeftSidebar'
import { useManager, useManagerPanel } from './ManagerPanel'
import { DockSheet } from './DockSheet'
import { ReportsPanel } from './Reports'
import { tip } from './Tooltip'
import { useLaunch } from '../pwa/launch'
import { openUrl, setUrl, useParam } from '../state/url'
import { ThreadsPanel } from './Threads'
import { FoldersTab } from './ProjectsTab'
import { SearchBox } from './SearchBox'

// Phones: the office gets the whole screen. Every side panel (attention queue, cron, tasks, reports, agents) opens
// as a bottom sheet from this floating dock; each button carries a count badge. The open sheet is in the address bar
// (?sheet=tasks), like every other modal (state/url.ts): the phone's Back (button or swipe) closes it.

type Sheet = 'attention' | 'cron' | 'tasks' | 'reports' | 'agents' | 'threads' | 'folders'
const SHEETS: Sheet[] = ['attention', 'cron', 'tasks', 'reports', 'agents', 'threads', 'folders']

function DockButton({ icon, label, count, alert, onClick }: { icon: ReactNode; label: string; count: number; alert?: boolean; onClick: () => void }) {
  return (
    <button className={`dock__btn${alert ? ' dock__btn--alert' : ''}`} onClick={() => (haptic(), onClick())} {...tip(count ? `${label} · ${count}` : label)}>
      {icon}
      <span className="dock__label">{label}</span>
      {count > 0 && <span className="dock__count">{count > 99 ? '99+' : count}</span>}
    </button>
  )
}

export function MobileDock() {
  const param = useParam('sheet')
  const sheet = SHEETS.includes(param as Sheet) ? (param as Sheet) : null
  // opening adds a history entry (Back closes it); switching between sheets doesn't stack them
  const setSheet = (s: Sheet) => (sheet ? setUrl({ sheet: s }) : openUrl({ sheet: s }))
  const close = () => setUrl({ sheet: null })
  // app shortcuts (/?open=tasks|attention) on a phone open the dock's sheet
  const launch = useLaunch((s) => s.open)
  useEffect(() => {
    if (launch !== 'tasks' && launch !== 'attention') return
    setSheet(launch)
    useLaunch.getState().done()
  }, [launch])
  const now = useNow(60_000).getTime()

  const attention = useAttentionCount()
  const activeCrons = useDashboard((s) => s.crons.filter((c) => c.enabled).length)
  const tasks = useDashboard((s) => s.tasks)
  const openTasks = useMemo(() => tasks.filter((t) => t.status !== 'done'), [tasks])
  const urgent = openTasks.filter((t) => t.deadline - now < 24 * 3_600_000).length
  const unreadReports = useDashboard((s) => s.reports.filter((r) => !r.read).length)
  // unread chat replies across the agents (the manager's have their own button)
  const unreadChats = useOffice((s) => s.agents.reduce((n, a) => n + (a.kind === 'manager' ? 0 : unreadOf(a)), 0))
  const waiting = useOffice((s) => s.agents.some((a) => a.status === 'waiting'))
  const manager = useManager()
  const openManager = useManagerPanel((s) => s.setOpen)

  return (
    <>
      <nav className={`dock${manager ? ' dock--six' : ''}`} aria-label="Panels">
        <DockButton icon={<LuInbox />} label="For you" count={attention} alert={attention > 0} onClick={() => setSheet('attention')} />
        <DockButton icon={<LuCalendarClock />} label="Daily" count={activeCrons} onClick={() => setSheet('cron')} />
        <DockButton icon={<LuBriefcase />} label="Work" count={urgent || openTasks.length} alert={urgent > 0} onClick={() => setSheet('tasks')} />
        <DockButton icon={<LuLibrary />} label="Docs" count={unreadReports} onClick={() => setSheet('reports')} />
        <DockButton icon={<LuBot />} label="Agents" count={unreadChats} alert={waiting} onClick={() => setSheet('agents')} />
        {manager && (
          <DockButton icon={<LuCrown />} label="Manager" count={unreadOf(manager)} alert={unreadOf(manager) > 0 || manager.status === 'waiting'} onClick={() => openManager(true)} />
        )}
      </nav>

      {/* always mounted: it keeps the tab-title count and the dock badge current */}
      <FollowUps sheet={{ open: sheet === 'attention', onClose: close }} />

      <DockSheet open={sheet === 'cron'} onClose={close} title="Daily" bodyClass="dock-sheet">
        <CronPanel />
      </DockSheet>
      <DockSheet open={sheet === 'tasks'} onClose={close} title="Work" bodyClass="dock-sheet">
        <TaskPanel noFolders />
      </DockSheet>
      {/* opened by the round Folders button on the stage */}
      <DockSheet open={sheet === 'folders'} onClose={close} title="Folders" bodyClass="dock-sheet">
        <FoldersSheet />
      </DockSheet>
      <DockSheet open={sheet === 'reports'} onClose={close} title="Docs" bodyClass="dock-sheet">
        <ReportsPanel />
      </DockSheet>
      {/* opened by the round Threads button on the stage (above the menu button), not from the dock */}
      <DockSheet open={sheet === 'threads'} onClose={close} title="Threads" bodyClass="dock-sheet">
        <ThreadsPanel />
      </DockSheet>
      <DockSheet open={sheet === 'agents'} onClose={close} title="Agents" bodyClass="dock-sheet agents-modal">
        {/* opening a chat keeps this sheet: closing the chat (or Back) comes back to it */}
        <AgentsCard />
      </DockSheet>
    </>
  )
}


/** The office's folders, from their own round button on the stage (phones; desktop's fullscreen office, ui/StageDock.tsx). */
export function FoldersSheet() {
  const [q, setQ] = useState('')
  return (
    <section className="card card--grow folders-sheet">
      <div className="side-search-row">
        <SearchBox value={q} onChange={setQ} placeholder="Search folders" className="side-search" />
      </div>
      <div className="side-pane">
        <FoldersTab q={q} />
      </div>
    </section>
  )
}

/** Phones: the round Folders button on the stage, right above the menu button (Threads above it). */
export function FoldersFab() {
  return (
    <button className="folders-fab" aria-label="Folders" onClick={() => openUrl({ sheet: 'folders' })}>
      <LuFolderGit2 />
    </button>
  )
}
