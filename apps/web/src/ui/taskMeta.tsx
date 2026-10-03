import { useState } from 'react'
import ReactSelect from 'react-select'
import { ProjectFolderPicker } from './ProjectFolderPicker'
import { LuCircleCheck, LuCircleX, LuFolder, LuHourglass, LuLoader, LuLock, LuCirclePause, LuX } from 'react-icons/lu'
import type { OfficeTask, TaskPriority, TaskStatus, TaskStatusDef } from '@after-office/shared'
import { useLive } from '../state/live'
import { openUrl } from '../state/url'
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

/** The four built-in statuses as definitions (the demo, or before the server has sent the owner's). */
const DEFAULT_DEFS: TaskStatusDef[] = STATUSES.map((s) => ({ id: s.value, label: s.label, color: s.color, base: s.value }))

/** The task statuses (board columns) in order: the owner's (live), else the built-in four. */
export function useStatuses(): TaskStatusDef[] {
  const live = useLive((s) => s.statuses)
  const isLive = useOffice((s) => s.source === 'live')
  return isLive && live.length ? live : DEFAULT_DEFS
}

/** Which status a task shows as: its own one while that still counts as its built-in status, else the built-in. */
export function statusDefOf(t: Pick<OfficeTask, 'status' | 'customStatus'>, defs: TaskStatusDef[]): TaskStatusDef {
  return (t.customStatus && defs.find((d) => d.id === t.customStatus && d.base === t.status)) || defs.find((d) => d.id === t.status) || DEFAULT_DEFS.find((d) => d.id === t.status)!
}

/**
 * The owner's own statuses act like the built-in one left of them on the board (before "To do": like to do): a
 * "Blocked" between In progress and Review is in progress to the office. Their place says it, no setting needed.
 */
export function withBases(list: TaskStatusDef[]): TaskStatusDef[] {
  let base: TaskStatus = 'todo'
  return list.map((d) => {
    if (d.id === d.base) {
      base = d.base
      return d
    }
    return { ...d, base }
  })
}

/** What moving a task to a status changes on it. */
export const statusPatch = (d: TaskStatusDef): Pick<OfficeTask, 'status' | 'customStatus'> => ({ status: d.base, customStatus: d.id === d.base ? undefined : d.id })

/** The definition a task shows as (hook). */
export const useStatusDef = (t: Pick<OfficeTask, 'status' | 'customStatus'>) => statusDefOf(t, useStatuses())

/** In the agent picker of a task: "Me", the owner's own task (never sent to an agent). */
export const OWNER = '@me'
/** The picker's value for a task: an agent, the owner ("Me"), or none. */
export const assigneeOf = (t: Pick<OfficeTask, 'agentId' | 'forOwner'>) => (t.forOwner ? OWNER : (t.agentId ?? ''))
/** What picking `v` changes on a task. */
export const assigneePatch = (v: string): Pick<OfficeTask, 'agentId' | 'forOwner'> => (v === OWNER ? { agentId: null, forOwner: true } : { agentId: v || null, forOwner: undefined })

export function AgentSelect({ value, onChange, size, withOwner }: { value: string; onChange: (v: string) => void; size?: 'sm' | 'md'; withOwner?: boolean }) {
  const agents = useOffice((s) => s.agents)
  return (
    <Select
      ariaLabel="Assign agent"
      searchable
      size={size}
      value={value}
      options={[
        // tasks only: the owner does it themselves (tracked, never sent to an agent)
        ...(withOwner ? [{ value: OWNER, label: 'Me (my own task)' }] : []),
        { value: '', label: 'Unassigned' },
        ...agents.map((a) => ({ value: a.id, label: a.name })),
        // a task still pointing at an agent that was removed
        ...(value && value !== OWNER && !agents.some((a) => a.id === value) ? [{ value, label: 'Removed agent' }] : []),
      ]}
      onChange={onChange}
    />
  )
}

const EDIT_STATUSES = '__edit'

/**
 * A task's status: any of the owner's statuses (its value: a status id, see statusDefOf); the last entry opens the
 * statuses editor (Tasks → Statuses) instead.
 */
export function StatusSelect({ value, onChange, size }: { value: string; onChange: (patch: Pick<OfficeTask, 'status' | 'customStatus'>) => void; size?: 'sm' | 'md' }) {
  const defs = useStatuses()
  const isLive = useOffice((s) => s.source === 'live')
  return (
    <Select
      ariaLabel="Status"
      size={size}
      value={value}
      options={[...defs.map((d) => ({ value: d.id, label: d.label })), ...(isLive ? [{ value: EDIT_STATUSES, label: 'Edit statuses…' }] : [])]}
      display={(o) => (
        <span className="status-opt">
          <span className="chip__dot" style={{ background: defs.find((d) => d.id === o.value)?.color }} />
          {o.label}
        </span>
      )}
      onChange={(v) => {
        if (v === EDIT_STATUSES) return openUrl({ statuses: '1' })
        const d = defs.find((x) => x.id === v)
        if (d) onChange(statusPatch(d))
      }}
    />
  )
}

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p
const tilde = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~')

/**
 * Where a task's agent works: a folder, however deep (the folder picker, with search), or none (its own folder).
 * Looks like the other fields' selects.
 */
export function FolderSelect({ value, onChange, size = 'md', none = 'Its own folder' }: { value?: string; onChange: (v: string | undefined) => void; size?: 'sm' | 'md'; none?: string }) {
  const [browsing, setBrowsing] = useState(false)
  return (
    <>
      {browsing && <ProjectFolderPicker onPick={(path) => onChange(path)} onClose={() => setBrowsing(false)} />}
      <span className={`folder-select folder-select--${size}`}>
        <button type="button" className="folder-select__pick" onClick={() => setBrowsing(true)} data-tip={value ? tilde(value) : 'Pick the folder to work in'}>
          <LuFolder />
          <span className={`truncate${value ? '' : ' muted'}`}>{value ? base(value) : none}</span>
        </button>
        {value && (
          <button type="button" className="folder-select__clear" aria-label="Its own folder" data-tip="Its own folder" onClick={() => onChange(undefined)}>
            <LuX />
          </button>
        )}
      </span>
    </>
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
  // stopped partway (the owner's Stop, the manager's interrupt): Resume, in the task, continues it
  const stopped =
    task.stoppedAt && task.status === 'todo' ? (
      <span className="blocked-badge blocked-badge--stopped" data-tip="Stopped partway: open it to Resume" aria-label="Stopped partway">
        <LuCirclePause />
      </span>
    ) : null
  if (!task.blockedBy?.length || task.status !== 'todo') return stopped
  const waiting = waitingOn(task, tasks)
  if (!waiting.length) return stopped
  return (
    <>
      {stopped}
      <span className="blocked-badge" data-tip={`Waits for ${waiting.map((t) => `"${t.title}"`).join(', ')}`} aria-label="Waiting for other tasks">
        <LuLock />
      </span>
    </>
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

/** A task's status as a coloured pill (its own status when it has one). */
export function StatusPill({ task }: { task: Pick<OfficeTask, 'status' | 'customStatus'> }) {
  const d = useStatusDef(task)
  return (
    <span className="status-pill" style={{ ['--c' as string]: d.color }}>
      {d.label}
    </span>
  )
}
