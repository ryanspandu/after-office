import { useMemo, useState, type ReactNode } from 'react'
import { LuBot, LuCalendarClock, LuFileText, LuFolderGit2, LuInbox, LuListTodo, LuMessagesSquare, LuNotebookPen } from 'react-icons/lu'
import { useNow } from '../state/clock'
import { useDashboard } from '../state/dashboard'
import { PANEL_LABEL, type PanelId } from '../state/layout'
import { useOffice } from '../state/store'
import { AgentsCard } from './AgentsPanel'
import { DockSheet } from './DockSheet'
import { FollowUps, useAttentionCount } from './FollowUps'
import { CronPanel, TaskPanel } from './LeftSidebar'
import { FoldersSheet } from './MobileDock'
import { ReportsPanel } from './Reports'
import { ThreadsPanel, useThreadUnread } from './Threads'
import { tip } from './Tooltip'

// Desktop, "Fullscreen office" (App.tsx): the stage fills the window and the dashboard's panels (state/layout.ts, all
// but the office itself) become round buttons stacked on the stage's right edge (the camera's buttons and "Advanced
// render" move to the left one), each with the count its panel shows.
// A click opens that panel as it is, in a modal (the phones' dock sheets, ui/DockSheet.tsx); one at a time. A click
// outside it or Esc closes it.

// Folders has a button of its own (as on phones), so the work panel goes without its Folders tab; Notes too, apart
// from the Reports it shares a card with
type Sheet = Exclude<PanelId, 'office'> | 'folders' | 'notes'
const WORK_LABEL = 'Tasks · Tags · Activity'

function StageButton({ icon, label, count, hot, active, onClick }: { icon: ReactNode; label: string; count?: number; hot?: boolean; active: boolean; onClick: () => void }) {
  return (
    <button className={`stage-dock__btn${active ? ' is-active' : ''}`} aria-pressed={active} onClick={onClick} {...tip(count ? `${label} · ${count}` : label, 'left')}>
      {icon}
      {!!count && <span className={`stage-dock__count${hot ? ' stage-dock__count--hot' : ''}`}>{count > 99 ? '99+' : count}</span>}
    </button>
  )
}

export function StageDock() {
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const toggle = (s: Sheet) => setSheet((v) => (v === s ? null : s))
  const close = () => setSheet(null)
  const now = useNow(60_000).getTime()

  // the same counts the panels show in their headers
  const attention = useAttentionCount()
  const threads = useThreadUnread()
  const reports = useDashboard((s) => s.reports.filter((r) => (!r.viaManager || r.job) && !r.read).length)
  const tasks = useDashboard((s) => s.tasks)
  const urgent = useMemo(() => tasks.filter((t) => t.status !== 'done' && t.deadline - now < 24 * 3_600_000).length, [tasks, now])
  const agents = useOffice((s) => s.agents.length)

  return (
    <>
      <nav className="stage-dock" aria-label="Panels">
        <StageButton icon={<LuInbox />} label={PANEL_LABEL.attention} count={attention} hot active={sheet === 'attention'} onClick={() => toggle('attention')} />
        <StageButton icon={<LuMessagesSquare />} label={PANEL_LABEL.threads} count={threads} hot active={sheet === 'threads'} onClick={() => toggle('threads')} />
        <StageButton icon={<LuFileText />} label={PANEL_LABEL.reports} count={reports} hot active={sheet === 'reports'} onClick={() => toggle('reports')} />
        <StageButton icon={<LuNotebookPen />} label="Notes" active={sheet === 'notes'} onClick={() => toggle('notes')} />
        <StageButton icon={<LuBot />} label={PANEL_LABEL.agents} count={agents} active={sheet === 'agents'} onClick={() => toggle('agents')} />
        <span className="stage-dock__sep" />
        <StageButton icon={<LuCalendarClock />} label={PANEL_LABEL.daily} active={sheet === 'daily'} onClick={() => toggle('daily')} />
        <StageButton icon={<LuFolderGit2 />} label="Folders" active={sheet === 'folders'} onClick={() => toggle('folders')} />
        <StageButton icon={<LuListTodo />} label={WORK_LABEL} count={urgent} hot active={sheet === 'work'} onClick={() => toggle('work')} />
      </nav>

      {/* always mounted: it keeps the tab-title count and the For you badge current */}
      <FollowUps sheet={{ open: sheet === 'attention', onClose: close }} />
      <DockSheet open={sheet === 'threads'} onClose={close} title={PANEL_LABEL.threads}>
        <ThreadsPanel />
      </DockSheet>
      <DockSheet open={sheet === 'reports'} onClose={close} title={PANEL_LABEL.reports}>
        <ReportsPanel only="reports" />
      </DockSheet>
      <DockSheet open={sheet === 'notes'} onClose={close} title="Notes">
        <ReportsPanel only="notes" />
      </DockSheet>
      <DockSheet open={sheet === 'agents'} onClose={close} title={PANEL_LABEL.agents} bodyClass="dock-sheet agents-modal">
        <AgentsCard />
      </DockSheet>
      <DockSheet open={sheet === 'daily'} onClose={close} title={PANEL_LABEL.daily}>
        <CronPanel />
      </DockSheet>
      <DockSheet open={sheet === 'folders'} onClose={close} title="Folders">
        <FoldersSheet />
      </DockSheet>
      <DockSheet open={sheet === 'work'} onClose={close} title={WORK_LABEL}>
        <TaskPanel noFolders />
      </DockSheet>
    </>
  )
}
