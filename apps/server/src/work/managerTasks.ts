import type { FollowUpDecision, LiveFollowUp, LiveMode, OfficeTask, TaskStatus } from '@after-office/shared'
import { agentsRepo, commentsRepo, queueRepo, tasksRepo } from '../db'
import { cleanFolder } from './folders'
import { AgentError } from '../agents/manager'
import { addPending, getPending, publish, resolvePending, runtimeOf } from '../agents/registry'
import { bossMode, countBoss, officeSettings } from './settings'
import { addComment, deliver, isReadingAgentOutput, isReportedNow, makesCycle, markTask, publishWork, quotaPause, startTask, tickTasks, waitingOn } from './work'
import { managerOrigin } from './origin'
import { requestCheckApproval } from './gate'
import { notifyUser } from './reports'

// What the manager does with tasks (through the after-office MCP tools, src/mcp.ts): delegating, the owner's approval
// of its tasks, assigning, editing, deleting and sending work back for another round.

export interface DelegateInput {
  agent: string
  title: string
  description: string
  priority?: OfficeTask['priority']
  /** epoch ms; default: 24 h from now */
  deadline?: number
  mode?: LiveMode
  /** task ids to wait for; the new task starts on its own when they are finished */
  after?: string[]
  /** where the agent works (unset: its own folder) */
  folder?: string | null
  /** tag ids (existing tags only) */
  tags?: string[]
  /** if the agent is busy, run it in a parallel session (when the owner allows it) */
  parallel?: boolean
}

/** Most prompts that may wait for one agent; stops a runaway manager from piling work on someone. */
export const MAX_QUEUED_PER_AGENT = 5

export async function delegateTask(managerId: string, input: DelegateInput) {
  const target = agentsRepo.get(input.agent)
  if (!target) throw new AgentError(`No agent with id ${input.agent}; call list_agents for ids`, 404)
  if (target.id === managerId) throw new AgentError('Delegate to another agent, not yourself')
  if (runtimeOf(target.id).status === 'offline') throw new AgentError(`${target.name} is offline right now`, 409)
  if (queueRepo.countFor(target.id) >= MAX_QUEUED_PER_AGENT)
    throw new AgentError(`${target.name} already has ${MAX_QUEUED_PER_AGENT} prompts waiting; wait for reports first`, 409)
  const task: OfficeTask = {
    id: `task-${crypto.randomUUID().slice(0, 12)}`,
    title: input.title.trim().slice(0, 200),
    description: input.description.trim().slice(0, 20_000),
    agentId: target.id,
    ...(cleanFolder(input.folder) ? { folder: cleanFolder(input.folder) } : {}),
    deadline: input.deadline ?? Date.now() + 24 * 3_600_000,
    priority: input.priority ?? 'medium',
    status: 'todo',
    mode: input.mode,
    delegatedBy: managerId,
    origin: managerOrigin(managerId),
    ...(input.tags?.length ? { tags: input.tags } : {}),
    ...(input.parallel ? { parallel: true } : {}),
  }
  const after = [...new Set(input.after ?? [])]
  for (const id of after) if (!tasksRepo.get(id)) throw new AgentError(`No task ${id} to wait for; see list_tasks`, 404)
  if (after.length) task.blockedBy = after
  const paused = quotaPause()
  // waiting (for other tasks, or for plan usage to drop): the task starts on its own later (tickTasks)
  if (after.length || paused) task.autoStart = true
  // the owner's approval: when they asked for it, or when this comes right after an agent's report (injection guard)
  // …except in Boss mode: the owner trusted the manager with it for now
  const boss = !!bossMode()
  const guarded = !boss && isReadingAgentOutput(managerId)
  const approval = !boss && (officeSettings().managerApproval || guarded)
  if (approval) task.awaitingApproval = true
  tasksRepo.put(task)
  publishWork('tasks')
  const manager = agentsRepo.get(managerId)?.name ?? 'The manager'
  addComment({ taskId: task.id, author: 'manager', agentId: managerId, text: `${manager} gave this to ${target.name}.` })
  if (boss) {
    addComment({ taskId: task.id, author: 'system', text: 'Started without approval (Boss mode).' })
    countBoss('tasks')
  }
  if (approval) {
    requestApproval(task, guarded ? 'Asked right after an agent\'s report: check it isn\'t something that report slipped in.' : undefined)
    return { task, result: 'approval' as const }
  }
  publish({ type: 'briefing', from: managerId, to: target.id, title: task.title })
  const waitingFor = waitingOn(task)
  if (waitingFor.length) return { task, result: 'waiting' as const, waitingFor: waitingFor.map((t) => t.title) }
  if (paused) return { task, result: 'paused' as const, paused }
  const result = await startTask(task.id)
  return { task: tasksRepo.get(task.id)!, result }
}

// ── approval of the manager's tasks ──

export const approvalId = (taskId: string) => `delegation-${taskId}`

/** Put a manager's new task in "Needs your attention". */
export function requestApproval(task: OfficeTask, reason?: string) {
  if (getPending(approvalId(task.id))) return
  const target = task.agentId ? agentsRepo.get(task.agentId) : null
  const blockers = (task.blockedBy ?? []).map((id) => tasksRepo.get(id)?.title).filter(Boolean)
  addPending({
    id: approvalId(task.id),
    agentId: task.delegatedBy!,
    kind: 'delegation',
    tool: 'delegate_task',
    message: `${target?.name ?? 'Someone'}: ${task.title}`,
    input: {
      taskId: task.id,
      agentId: task.agentId,
      agentName: target?.name ?? null,
      title: task.title,
      description: task.description ?? '',
      after: blockers,
      mode: task.mode ?? null,
      folder: task.folder ?? null,
      ...(reason ? { reason } : {}),
    },
    createdAt: Date.now(),
  })
}

/** After a restart: the approvals that were waiting are asked again. */
export function restoreApprovals() {
  for (const t of tasksRepo.active()) {
    if (t.awaitingApproval && t.delegatedBy) requestApproval(t)
    if (t.pendingCheck) requestCheckApproval(t)
  }
}

/** The owner approved or rejected a manager's task. */
export async function decideDelegation(f: LiveFollowUp, d: FollowUpDecision) {
  const taskId = String(f.input.taskId ?? '')
  resolvePending(f.id)
  const task = tasksRepo.get(taskId)
  if (!task) return
  const managerId = task.delegatedBy
  if (d.type === 'allow') {
    // a note with the approval is for the agent doing it: it goes into the task it's given
    const note = d.note?.trim()
    const approved = { ...task, awaitingApproval: undefined, ...(note ? { description: `${task.description?.trim() ? `${task.description.trim()}\n\n` : ''}Note from the owner: ${note}` } : {}) }
    tasksRepo.put(approved)
    publishWork('tasks')
    addComment({ taskId, author: 'user', text: d.note?.trim() ? `Approved: ${d.note.trim()}` : 'Approved.' })
    if (task.agentId) publish({ type: 'briefing', from: managerId ?? task.agentId, to: task.agentId, title: task.title })
    if (!waitingOn(approved).length && !quotaPause() && task.agentId) await startTask(taskId)
    else void tickTasks()
    return
  }
  if (d.type !== 'deny') throw new AgentError('Approve or reject this task')
  tasksRepo.remove(taskId)
  commentsRepo.removeTask(taskId)
  publishWork('tasks')
  if (managerId && agentsRepo.get(managerId)) {
    const who = task.agentId ? (agentsRepo.get(task.agentId)?.name ?? 'the agent') : 'nobody'
    const note = d.note?.trim()
    await deliver(managerId, `[After Office] The owner rejected your task "${task.title}" for ${who}${note ? `. Their note: ${note}` : '.'} It was not started and has been removed.`)
  }
}

/** The manager picks who does an unassigned task (auto-assign). */
export async function assignTask(managerId: string, taskId: string, agentId: string) {
  const task = tasksRepo.get(taskId)
  if (!task) throw new AgentError(`No task ${taskId}; see list_tasks`, 404)
  if (task.status !== 'todo') throw new AgentError(`"${task.title}" is already ${task.status}`, 409)
  const target = agentsRepo.get(agentId)
  if (!target || target.id === managerId) throw new AgentError('Pick another agent', 404)
  if (runtimeOf(target.id).status === 'offline') throw new AgentError(`${target.name} is offline right now`, 409)
  markTask(taskId, { agentId: target.id, autoStart: true, autoStartedAt: undefined })
  addComment({ taskId, author: 'manager', agentId: managerId, text: `${agentsRepo.get(managerId)?.name ?? 'The manager'} gave this to ${target.name}.` })
  publish({ type: 'briefing', from: managerId, to: target.id, title: task.title })
  await tickTasks()
  const now = tasksRepo.get(taskId)!
  return now.autoStartedAt ? ('started' as const) : waitingOn(now).length ? ('waiting' as const) : ('on hold' as const)
}

// ── the manager editing and removing tasks ──

export interface ManagerTaskPatch {
  title?: string
  description?: string
  priority?: OfficeTask['priority']
  deadline?: number
  /** in_progress is the office's to set (by starting the task) */
  status?: Exclude<TaskStatus, 'in_progress'>
  agentId?: string | null
  /** '' / null: back to the agent's own folder */
  folder?: string | null
  blockedBy?: string[]
  /** '' clears it */
  check?: string
  /** tag ids (replaces the list; [] = none) */
  tags?: string[]
}

const managerName = (id: string) => agentsRepo.get(id)?.name ?? 'The manager'

export async function managerUpdateTask(managerId: string, taskId: string, patch: ManagerTaskPatch) {
  const t = tasksRepo.get(taskId)
  if (!t) throw new AgentError(`No task ${taskId}; see list_tasks`, 404)
  const next: OfficeTask = { ...t }
  const changed: string[] = []
  const busy = t.status === 'in_progress'

  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw new AgentError('The title cannot be empty')
    next.title = patch.title.trim().slice(0, 200)
    changed.push('title')
  }
  if (patch.description !== undefined) {
    next.description = patch.description.trim().slice(0, 20_000) || undefined
    changed.push('description')
  }
  if (patch.priority !== undefined) {
    next.priority = patch.priority
    changed.push('priority')
  }
  if (patch.deadline !== undefined) {
    next.deadline = patch.deadline
    changed.push('deadline')
  }
  // a check command runs on the server, outside Claude Code's permission prompts: a new one needs the owner's approval
  let proposedCheck: string | undefined
  if (patch.check !== undefined) {
    const cmd = patch.check.trim().slice(0, 1000)
    if (!cmd) {
      next.check = undefined
      next.pendingCheck = undefined
      changed.push('quality check (removed)')
    } else if (cmd !== t.check) {
      next.pendingCheck = cmd
      proposedCheck = cmd
    }
  }
  if (patch.tags !== undefined) {
    next.tags = patch.tags.length ? patch.tags : undefined
    changed.push('tags')
  }
  if (patch.folder !== undefined) {
    if (busy) throw new AgentError(`"${t.title}" is in progress; change its folder once it's done`, 409)
    const folder = cleanFolder(patch.folder)
    if (folder) next.folder = folder
    else delete next.folder
    changed.push('folder')
  }
  if (patch.agentId !== undefined) {
    if (busy) throw new AgentError(`"${t.title}" is in progress; wait for its report before moving it to someone else`, 409)
    if (patch.agentId) {
      const a = agentsRepo.get(patch.agentId)
      if (!a || a.id === managerId) throw new AgentError('Pick another agent', 404)
    }
    next.agentId = patch.agentId
    next.autoStartedAt = undefined
    changed.push('agent')
  }
  if (patch.blockedBy !== undefined) {
    const ids = [...new Set(patch.blockedBy)].filter((id) => id !== taskId)
    for (const id of ids) if (!tasksRepo.get(id)) throw new AgentError(`No task ${id} to wait for`, 404)
    if (makesCycle(taskId, ids)) throw new AgentError('That would make tasks wait for each other in a loop')
    next.blockedBy = ids.length ? ids : undefined
    if (next.status === 'todo') next.autoStartedAt = undefined
    changed.push('what it waits for')
  }
  if (patch.status !== undefined && patch.status !== t.status) {
    if (busy) throw new AgentError(`"${t.title}" is in progress; wait for its report before changing its status`, 409)
    next.status = patch.status
    // back to To do: it may start on its own again
    if (patch.status === 'todo') next.autoStartedAt = undefined
    changed.push(`status (${t.status} → ${patch.status})`)
  }
  if (!changed.length && !proposedCheck) return next

  tasksRepo.put(next)
  if (proposedCheck) requestCheckApproval(next)
  if (!changed.length) return next
  publishWork('tasks')
  const who = managerName(managerId)
  addComment({
    taskId,
    author: 'manager',
    agentId: managerId,
    text: t.status === 'review' && next.status === 'done' ? `${who} accepted it.` : `${who} changed the ${changed.join(', ')}.`,
  })
  // a task still waiting for approval: show the owner the current version
  if (next.awaitingApproval) {
    resolvePending(approvalId(taskId))
    requestApproval(next)
  }
  void tickTasks()
  return next
}

export function managerDeleteTask(managerId: string, taskId: string) {
  const t = tasksRepo.get(taskId)
  if (!t) throw new AgentError(`No task ${taskId}; see list_tasks`, 404)
  if (t.status === 'in_progress') throw new AgentError(`"${t.title}" is in progress; wait for its report (or ask the owner to stop it)`, 409)
  tasksRepo.remove(taskId)
  commentsRepo.removeTask(taskId)
  queueRepo.removeTask(taskId)
  resolvePending(approvalId(taskId))
  publishWork('tasks', 'queued')
  // the owner's own tasks don't vanish silently
  if (t.delegatedBy !== managerId) notifyUser(managerId, `${managerName(managerId)} deleted a task`, `"${t.title}" (${t.status}) was removed.`)
  return t
}

/** Rounds the manager may send one task back without the owner; after that the owner decides. */
export const MAX_MANAGER_REVISIONS = 3

/**
 * The manager wants another round on a task it delegated: the feedback goes to the same agent, on the same task. Allowed
 * right after a report (it only asks that agent to fix its own work), but only for the tasks that report is about, and
 * at most MAX_MANAGER_REVISIONS times in a row before the owner steps in.
 */
export async function managerReviseTask(managerId: string, taskId: string, feedback: string) {
  const task = tasksRepo.get(taskId)
  if (!task) throw new AgentError(`No task ${taskId}; see list_tasks`, 404)
  if (task.delegatedBy !== managerId) throw new AgentError('You can only send back tasks you delegated')
  if (task.status !== 'review' && task.status !== 'done') throw new AgentError(`"${task.title}" is ${task.status}: only finished work goes back for another round`)
  // Boss mode: no limits on rounds, and any of its finished tasks
  if (bossMode()) {
    countBoss('sendBacks')
    return reviseTask(taskId, feedback, { author: 'manager', agentId: managerId })
  }
  if (isReadingAgentOutput(managerId) && !isReportedNow(managerId, taskId))
    throw new AgentError("Right after a report, you can only send back the task that report is about. For other work, tell the owner or use delegate_task (the owner approves it).")
  // rounds in a row: the manager's revisions since the owner last said anything on the task
  const timeline = commentsRepo.forTask(taskId)
  let rounds = 0
  for (let i = timeline.length - 1; i >= 0 && timeline[i].author !== 'user'; i--) if (timeline[i].author === 'manager' && timeline[i].kind === 'revision') rounds++
  if (rounds >= MAX_MANAGER_REVISIONS)
    throw new AgentError(`"${task.title}" already went back ${rounds} times: ask the owner (notify_user) how to go on instead of another round`)
  return reviseTask(taskId, feedback, { author: 'manager', agentId: managerId })
}

/** The human reviewed the agent's work and wants changes: send the feedback to the same agent as a revision run. */
export async function reviseTask(taskId: string, feedback: string, by: { author: 'user' | 'manager'; agentId?: string } = { author: 'user' }) {
  const task = tasksRepo.get(taskId)
  if (!task) throw new AgentError('No such task', 404)
  if (!task.agentId || !agentsRepo.get(task.agentId)) throw new AgentError('Assign the task to an agent first')
  const note = feedback.trim()
  if (!note) throw new AgentError('Write what should change')
  const prompt = [
    `Revision requested for the task: ${task.title}`,
    `\nFeedback:\n${note}`,
    '\nApply the feedback. When you are done, give a short summary of what you changed.',
  ].join('\n')
  const result = await deliver(task.agentId, prompt, { taskId })
  markTask(taskId, {
    ...(result === 'sent' ? { status: 'in_progress' as const, startedAt: Date.now() } : { status: 'todo' as const }),
    checkState: undefined,
    checkAttempts: undefined,
  })
  addComment({ taskId, author: by.author, ...(by.agentId ? { agentId: by.agentId } : {}), kind: 'revision', text: note })
  return result
}
