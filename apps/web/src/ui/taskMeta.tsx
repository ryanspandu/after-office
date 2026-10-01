import ReactSelect from 'react-select'
import { LuCircleCheck, LuCircleX, LuFolder, LuHourglass, LuLoader, LuLock } from 'react-icons/lu'
import { projectFolders, useWorkspaces } from '../state/workspaces'
import CreatableSelect from 'react-select/creatable'
import type { OfficeTask, TaskPriority, TaskStatus } from '@after-office/shared'
import { useDashboard } from '../state/dashboard'
import { useOffice } from '../state/store'
import { Select, type Option } from './Select'

// Shared bits for task lists, the task board and task forms.

export const HOUR = 3_600_000

export function dueInfo(deadline: number, now: number) {
  const diff = deadline - now
  const abs = Math.abs(diff)
  const text = abs < HOUR ? `${Math.max(1, Math.round(abs / 60_000))}m` : abs < 48 * HOUR ? `${Math.round(abs / HOUR)}h` : `${Math.round(abs / (24 * HOUR))}d`
  if (diff < 0) return { level: 'overdue', text: `${text} overdue` }
  if (diff < 24 * HOUR) return { level: 'soon', text: `due in ${text}` }
  return { level: 'later', text: `due in ${text}` }
}

export const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 }
export const PRIORITY_OPTIONS: Option<TaskPriority>[] = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
]

export const STATUSES: { value: TaskStatus; label: string; color: string }[] = [
  { value: 'todo', label: 'To do', color: '#9a9a96' },
  { value: 'in_progress', label: 'In progress', color: '#3b82f6' },
  { value: 'review', label: 'Review', color: '#f07a1d' },
  { value: 'done', label: 'Done', color: '#2f8f57' },
]
export const STATUS_BY_ID = Object.fromEntries(STATUSES.map((s) => [s.value, s])) as Record<TaskStatus, (typeof STATUSES)[number]>

export function AgentSelect({ value, onChange, size }: { value: string; onChange: (v: string) => void; size?: 'sm' | 'md' }) {
  const agents = useOffice((s) => s.agents)
  return (
    <Select
      ariaLabel="Assign agent"
      searchable
      size={size}
      value={value}
      options={[
        { value: '', label: 'Unassigned' },
        ...agents.map((a) => ({ value: a.id, label: a.name })),
        // a task still pointing at an agent that was removed
        ...(value && !agents.some((a) => a.id === value) ? [{ value, label: 'Removed agent' }] : []),
      ]}
      onChange={onChange}
    />
  )
}

export function StatusSelect({ value, onChange, size }: { value: TaskStatus; onChange: (v: TaskStatus) => void; size?: 'sm' | 'md' }) {
  return <Select ariaLabel="Status" size={size} value={value} options={STATUSES} onChange={onChange} />
}

/** Project picker; typing a new name creates the project. */
type ProjectOption = Option<string> & { hint?: string; folder?: boolean }

/**
 * Pick a project, or one of the folders the agents work in (which becomes a project linked to that folder), or
 * type a new name.
 */
export function ProjectSelect({ value, onChange, size = 'md', menuPlacement = 'auto' }: { value: string; onChange: (v: string) => void; size?: 'sm' | 'md'; menuPlacement?: 'auto' | 'top' }) {
  const projects = useDashboard((s) => s.projects)
  const addProject = useDashboard((s) => s.addProject)
  const live = useOffice((s) => s.source === 'live')
  const workspaces = useWorkspaces((s) => s.data)
  const loadWorkspaces = useWorkspaces((s) => s.load)
  const linked = new Set(projects.map((p) => p.folder).filter(Boolean))
  const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p

  const projectOptions: ProjectOption[] = [
    { value: '', label: 'No project' },
    ...projects.map((p) => ({ value: p.id, label: p.name, hint: p.folder ? base(p.folder) : undefined })),
  ]
  const folderOptions: ProjectOption[] = projectFolders(workspaces)
    .filter((f) => !f.projectId && !linked.has(f.path))
    .map((f) => ({ value: `folder:${f.path}`, label: f.name, hint: f.path, folder: true }))
  const groups = folderOptions.length
    ? [
        { label: 'Projects', options: projectOptions },
        { label: 'Folders your agents work in', options: folderOptions },
      ]
    : projectOptions

  const pick = (v: string) => {
    if (!v.startsWith('folder:')) return onChange(v)
    const folder = v.slice('folder:'.length)
    onChange(addProject(base(folder), { folder }))
  }

  return (
    <CreatableSelect<ProjectOption, false>
      unstyled
      aria-label="Project"
      className={`rs rs--${size}`}
      classNamePrefix="rs"
      value={projectOptions.find((o) => o.value === value) ?? projectOptions[0]}
      options={groups}
      onMenuOpen={() => live && void loadWorkspaces()}
      onChange={(o) => o && pick(o.value)}
      onCreateOption={(name) => onChange(addProject(name.trim()))}
      formatCreateLabel={(name) => `Create project “${name}”`}
      formatOptionLabel={(o, meta) =>
        meta.context === 'menu' && (o.hint || o.folder) ? (
          <span className="proj-opt">
            {o.folder ? <LuFolder /> : null}
            <span className="truncate">{o.label}</span>
            {o.hint && <span className="muted truncate">{o.hint}</span>}
          </span>
        ) : (
          o.label
        )
      }
      placeholder="Search or create…"
      menuPortalTarget={document.body}
      menuPlacement={menuPlacement}
      classNames={{
        control: (s) => (s.isFocused ? 'rs__control--focused' : ''),
        option: (s) => [s.isSelected && 'rs__option--selected', s.isFocused && 'rs__option--focused'].filter(Boolean).join(' '),
      }}
    />
  )
}

export function ProjectTag({ projectId }: { projectId: string | null }) {
  const project = useDashboard((s) => s.projects.find((p) => p.id === projectId))
  if (!project) return null
  return (
    <span className="project-tag" style={{ ['--c' as string]: project.color }}>
      {project.name}
    </span>
  )
}

/** A task counts as finished for the ones waiting on it once its agent is done (review or done). Mirrors the server. */
export const isFinished = (t: OfficeTask) => t.status === 'review' || t.status === 'done'

/** The unfinished tasks `t` still waits for. */
export function waitingOn(t: OfficeTask, tasks: OfficeTask[]) {
  return (t.blockedBy ?? []).map((id) => tasks.find((x) => x.id === id)).filter((b): b is OfficeTask => !!b && !isFinished(b))
}

/** Pick the tasks this one waits for (not itself; done tasks are left out since they can't block anyway). */
export function WaitsForSelect({ taskId, value, onChange }: { taskId?: string; value: string[]; onChange: (ids: string[]) => void }) {
  const tasks = useDashboard((s) => s.tasks)
  const options = tasks
    .filter((t) => t.id !== taskId && (t.status !== 'done' || value.includes(t.id)))
    .map((t) => ({ value: t.id, label: t.title || 'Untitled', status: t.status }))
  return (
    <ReactSelect<(typeof options)[number], true>
      unstyled
      isMulti
      isClearable={false}
      placeholder="Nothing: it can start any time"
      noOptionsMessage={() => 'No other tasks'}
      aria-label="Waits for"
      className="rs rs--md rs--multi"
      classNamePrefix="rs"
      value={options.filter((o) => value.includes(o.value))}
      options={options}
      formatOptionLabel={(o, meta) =>
        meta.context === 'menu' ? (
          <span className="waits-opt">
            <span className="chip__dot" style={{ background: STATUS_BY_ID[o.status].color }} />
            <span className="truncate">{o.label}</span>
            <span className="muted">{STATUS_BY_ID[o.status].label}</span>
          </span>
        ) : (
          o.label
        )
      }
      onChange={(list) => onChange(list.map((o) => o.value))}
      menuPortalTarget={document.body}
      menuPlacement="auto"
      classNames={{
        control: (s) => (s.isFocused ? 'rs__control--focused' : ''),
        option: (s) => [s.isSelected && 'rs__option--selected', s.isFocused && 'rs__option--focused'].filter(Boolean).join(' '),
      }}
    />
  )
}

/** Small lock shown on a task that still waits for others. */
export function BlockedBadge({ task }: { task: OfficeTask }) {
  const tasks = useDashboard((s) => s.tasks)
  if (!task.blockedBy?.length || task.status !== 'todo') return null
  const waiting = waitingOn(task, tasks)
  if (!waiting.length) return null
  return (
    <span className="blocked-badge" data-tip={`Waits for ${waiting.map((t) => `"${t.title}"`).join(', ')}`} aria-label="Waiting for other tasks">
      <LuLock />
    </span>
  )
}

/** Quality gate / approval state of a task, as a small icon. */
export function CheckBadge({ task }: { task: OfficeTask }) {
  if (task.awaitingApproval)
    return (
      <span className="check-badge check-badge--approval" data-tip="Waiting for your approval (from the manager)" aria-label="Waiting for approval">
        <LuHourglass />
      </span>
    )
  if (!task.checkState) return null
  const meta = {
    running: { icon: <LuLoader className="spin" />, tip: 'Running the quality check…' },
    passed: { icon: <LuCircleCheck />, tip: 'Quality check passed' },
    failed: { icon: <LuCircleX />, tip: task.status === 'in_progress' ? `Check failed; the agent is fixing it (round ${task.checkAttempts ?? 1})` : 'Quality check failed' },
  }[task.checkState]
  return (
    <span className={`check-badge check-badge--${task.checkState}`} data-tip={meta.tip} aria-label={meta.tip}>
      {meta.icon}
    </span>
  )
}
