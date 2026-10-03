import type { TaskStatus, TaskStatusDef } from '@after-office/shared'
import { settingsRepo, tasksRepo } from '../db'
import { AgentError } from '../agents/manager'

// Task statuses (board columns): the four built-in ones, which the office's logic goes by (start, review, done,
// what waits for what), renamed / recoloured / reordered as the owner likes; and the owner's own, each counting as one
// of the four. A task keeps its built-in `status`; `customStatus` only says which column it shows in.

const KEY = 'taskStatuses'
const BASES: TaskStatus[] = ['todo', 'in_progress', 'review', 'done']
const MAX = 20

export const DEFAULT_STATUSES: TaskStatusDef[] = [
  { id: 'todo', label: 'To do', color: '#9a9a96', base: 'todo' },
  { id: 'in_progress', label: 'In progress', color: '#3b82f6', base: 'in_progress' },
  { id: 'review', label: 'Review', color: '#f07a1d', base: 'review' },
  { id: 'done', label: 'Done', color: '#2f8f57', base: 'done' },
]

const isBase = (v: unknown): v is TaskStatus => BASES.includes(v as TaskStatus)

/** A list of statuses as given (the dashboard's editor), checked: every built-in one there once; bad ones refused. */
export function cleanStatuses(input: unknown): TaskStatusDef[] {
  if (!Array.isArray(input) || !input.length) throw new AgentError('Send the statuses as a list', 400)
  if (input.length > MAX) throw new AgentError(`At most ${MAX} statuses`, 400)
  const out: TaskStatusDef[] = []
  for (const raw of input as Record<string, unknown>[]) {
    const label = typeof raw?.label === 'string' ? raw.label.replace(/\s+/g, ' ').trim().slice(0, 30) : ''
    if (!label) throw new AgentError('Every status needs a name', 400)
    const color = typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : '#9a9a96'
    const builtIn = isBase(raw.id)
    const base = builtIn ? (raw.id as TaskStatus) : isBase(raw.base) ? raw.base : null
    if (!base) throw new AgentError(`"${label}": pick what it counts as (to do, in progress, review or done)`, 400)
    const id = builtIn ? (raw.id as string) : typeof raw.id === 'string' && /^st-[a-z0-9]{4,16}$/.test(raw.id) ? raw.id : `st-${crypto.randomUUID().slice(0, 8)}`
    if (out.some((s) => s.id === id)) throw new AgentError('A status is listed twice', 400)
    out.push({ id, label, color, base })
  }
  for (const b of BASES) if (!out.some((s) => s.id === b)) throw new AgentError(`The built-in status "${DEFAULT_STATUSES.find((s) => s.id === b)!.label}" can be renamed, not removed`, 400)
  return out
}

export function taskStatuses(): TaskStatusDef[] {
  try {
    const saved = JSON.parse(settingsRepo.get(KEY) ?? 'null') as unknown
    return saved ? cleanStatuses(saved) : DEFAULT_STATUSES
  } catch {
    return DEFAULT_STATUSES
  }
}

/**
 * Store the owner's statuses. Tasks in one that's gone go back to its built-in status; tasks in one that now works
 * like another built-in status (moved elsewhere on the board) stay in it, and take that status.
 */
export function saveStatuses(input: unknown) {
  const list = cleanStatuses(input)
  settingsRepo.set(KEY, JSON.stringify(list))
  for (const t of tasksRepo.active()) {
    if (!t.customStatus) continue
    const def = list.find((s) => s.id === t.customStatus)
    if (!def) {
      const { customStatus: _, ...rest } = t
      tasksRepo.put(rest)
    } else if (def.base !== t.status) tasksRepo.put({ ...t, status: def.base })
  }
  return list
}

/** A task's own status, if it still fits (it exists and counts as the task's built-in status). */
export function cleanCustomStatus(v: unknown, status: TaskStatus) {
  if (typeof v !== 'string') return undefined
  const def = taskStatuses().find((s) => s.id === v)
  return def && !isBase(def.id) && def.base === status ? def.id : undefined
}

/** The name a task's status shows as. */
export const statusLabel = (status: TaskStatus, custom?: string) => {
  const list = taskStatuses()
  return (custom && list.find((s) => s.id === custom && s.base === status)?.label) || list.find((s) => s.id === status)?.label || status
}
