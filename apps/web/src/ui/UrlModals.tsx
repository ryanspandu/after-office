import { useEffect } from 'react'
import type { OfficeTask, TaskStatus } from '@after-office/shared'
import { useDashboard } from '../state/dashboard'
import { useOffice } from '../state/store'
import { getParam, setUrl, useUrl } from '../state/url'
import { useWorkspaces } from '../state/workspaces'
import { AddAgentModal } from './AddAgentModal'
import { ArchiveModal } from './ArchiveModal'
import { useAutomationModal } from './AutomationModal'
import { CronModal, TaskModal } from './LeftSidebar'
import { useManagerPanel } from './ManagerPanel'
import { useProfileModal } from './ProfileModal'
import { ProjectsModal } from './ProjectsModal'
import { NewProjectModal, ProjectFolderModal, type Open } from './ProjectsTab'
import { ProjectSettingsModal } from './ProjectSettings'
import { ChangePasswordModal } from './ChangePassword'
import { TwoFactorModal } from './TwoFactor'
import { EditProfileModal } from './EditProfile'
import { ActivityModal } from './Activity'
import { ReportModal, ReportsModal } from './Reports'
import { TaskDetailModal } from './TaskDetail'
import { TasksModal } from './TasksModal'

// Every modal, shown from the address bar (state/url.ts). Stacking follows the order below: lists first, then what
// is opened from them (a task, a report), then forms and settings on top.

const REPORTS_VIEW = ['reports', 'q', 'range', 'from', 'to', 'page', 'per', 'project', 'tag', 'by']
const clear = (keys: string[]) => () => setUrl(Object.fromEntries(keys.map((k) => [k, null])))

export function UrlModals() {
  const p = useUrl((s) => s.params)
  useStoreSync()
  return (
    <>
      {p.tasks && <TasksModal onClose={clear(['tasks', 'tq'])} />}
      {p.archive && <ArchiveModal onClose={clear(['archive'])} />}
      {p.projects && <ProjectsModal onClose={clear(['projects'])} />}
      {p.reports && <ReportsModal onClose={clear(REPORTS_VIEW)} />}
      {p.folder && <FolderFromUrl path={p.folder} />}
      {p.newproject && (
        <NewProjectModal onClose={clear(['newproject'])} onCreated={(folder) => setUrl({ newproject: null, folder: folder.path }, 'push')} />
      )}
      {p.task && <TaskDetailModal key={p.task} taskId={p.task} onClose={clear(['task'])} />}
      {p.report && <ReportModal key={p.report} id={p.report} onClose={clear(['report'])} />}
      {p.newtask && <NewTaskFromUrl />}
      {p.daily && <CronFromUrl id={p.daily} />}
      {p.settings && <ProjectSettingsModal onClose={clear(['settings'])} />}
      {p.password && <ChangePasswordModal onClose={clear(['password'])} />}
      {p.twofa && <TwoFactorModal onClose={clear(['twofa'])} />}
      {p.editprofile && <EditProfileModal onClose={clear(['editprofile'])} />}
      {p.activity && <ActivityModal onClose={clear(['activity'])} />}
      <AddAgentModal open={p.addagent === '1'} onClose={clear(['addagent'])} />
      <AddAgentModal open={p.addagent === 'manager'} onClose={clear(['addagent'])} manager />
    </>
  )
}

/** A folder of the Projects tab, found in the scan (read if it isn't loaded yet). */
function FolderFromUrl({ path }: { path: string }) {
  const data = useWorkspaces((s) => s.data)
  const load = useWorkspaces((s) => s.load)
  useEffect(() => {
    if (!data) void load()
  }, [data, load])
  if (!data) return null
  let open: Open | null = null
  for (const w of data) {
    if (w.path === path) open = { folder: w, agentIds: w.agentIds, orphan: w.orphan }
    const sub = w.projects.find((f) => f.path === path)
    if (sub) open = { folder: sub, agentIds: w.agentIds }
    if (open) break
  }
  // a folder deeper inside one of them (opened from the tree): its details too, with the agents of the folder it's in
  if (!open) {
    const parent = data.find((w) => path.startsWith(`${w.path}/`))
    if (parent) open = { folder: { path, name: path.split('/').pop() ?? path, git: null, updatedAt: 0 }, agentIds: parent.agentIds }
  }
  if (!open) return null
  return <ProjectFolderModal key={path} open={open} onClose={clear(['folder'])} />
}

const STATUSES: TaskStatus[] = ['todo', 'in_progress', 'review', 'done']

function NewTaskFromUrl() {
  const p = useUrl((s) => s.params)
  const defaults: Partial<Pick<OfficeTask, 'agentId' | 'projectId' | 'status'>> = {
    ...(p.nt_agent ? { agentId: p.nt_agent } : {}),
    ...(p.nt_project ? { projectId: p.nt_project } : {}),
    ...(STATUSES.includes(p.nt_status as TaskStatus) ? { status: p.nt_status as TaskStatus } : {}),
  }
  return <TaskModal defaults={defaults} onClose={clear(['newtask', 'nt_agent', 'nt_project', 'nt_status'])} />
}

function CronFromUrl({ id }: { id: string }) {
  const cron = useDashboard((s) => s.crons.find((c) => c.id === id))
  const loaded = useDashboard((s) => s.crons.length > 0)
  if (id !== 'new' && !cron) return loaded ? null : null
  return <CronModal key={id} cron={id === 'new' ? undefined : cron} onClose={clear(['daily'])} />
}

/**
 * The panels that keep their own open state (agent drawer, manager panel, automation, profile) follow the URL, and
 * the URL follows them: opening one from a button adds its parameter, a link opens it.
 */
function useStoreSync() {
  const p = useUrl((s) => s.params)
  const live = useOffice((s) => s.source === 'live')
  const agentsKnown = useOffice((s) => s.agents.length > 0)

  // URL → panels
  useEffect(() => {
    const office = useOffice.getState()
    const agent = p.agent ?? null
    if (agent !== office.profileId && (agent === null || office.agents.some((a) => a.id === agent))) office.openProfile(agent)
    const manager = !!p.manager
    if (manager !== useManagerPanel.getState().open) useManagerPanel.getState().setOpen(manager)
    const automation = !!p.automation
    if (automation !== useAutomationModal.getState().open) useAutomationModal.getState().setOpen(automation)
    const profile = !!p.profile
    if (profile !== useProfileModal.getState().open) useProfileModal.getState().setOpen(profile)
  }, [p.agent, p.manager, p.automation, p.profile, live, agentsKnown])

  // panels → URL
  useEffect(() => {
    const unsubs = [
      useOffice.subscribe((s, prev) => {
        if (s.profileId === prev.profileId || s.profileId === getParam('agent')) return
        // an agent's drawer only once the agents are known (a link opened while loading waits for them)
        if (!s.profileId && getParam('agent') && !s.agents.some((a) => a.id === getParam('agent'))) return
        setUrl({ agent: s.profileId, tab: null, session: null }, s.profileId ? 'push' : 'replace')
      }),
      useManagerPanel.subscribe((s) => {
        if (s.open === !!getParam('manager')) return
        setUrl({ manager: s.open ? '1' : null, mtab: null, session: null }, s.open ? 'push' : 'replace')
      }),
      useAutomationModal.subscribe((s) => {
        if (s.open === !!getParam('automation')) return
        setUrl({ automation: s.open ? '1' : null }, s.open ? 'push' : 'replace')
      }),
      useProfileModal.subscribe((s) => {
        if (s.open === !!getParam('profile')) return
        setUrl({ profile: s.open ? '1' : null }, s.open ? 'push' : 'replace')
      }),
    ]
    return () => unsubs.forEach((u) => u())
  }, [])
}
