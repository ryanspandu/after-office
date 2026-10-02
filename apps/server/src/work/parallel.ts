import { resolve } from 'node:path'
import type { OfficeTask } from '@after-office/shared'
import { agentsRepo, queueRepo, sideSessionsRepo, tasksRepo } from '../db'
import { closeSideSession, grantFolder, openSideSession, renameSideSession, sendPrompt } from '../agents/manager'
import { runtimeOf, sideRuntimeOf } from '../agents/registry'
import { officeSettings } from './settings'
import { active, addComment, fileReport, markTask, taskFolder, tickTasks, type WorkRef } from './work'
import { checkFor, runGate } from './gate'

// Parallel tasks: a task marked `parallel` whose agent is busy runs in a session of its own (a side session, s2, s3…)
// next to the busy one, instead of waiting in the queue. Within limits: the owner allows it (Office settings, at most
// that many per agent; off by default), and its folder doesn't overlap the work the agent is already doing (two
// sessions editing the same files). The session closes when the task's turn ends; its report is filed like any other.

/** The tasks running in an agent's parallel sessions right now. */
export const parallelTasks = (agentId: string) => tasksRepo.active().filter((t) => t.agentId === agentId && t.status === 'in_progress' && !!t.sessionKey)

/** The task running in this side session, if it is one of the parallel ones. */
export const taskInSession = (agentId: string, key: string) => parallelTasks(agentId).find((t) => t.sessionKey === key) ?? null

const overlaps = (a: string, b: string) => {
  const x = resolve(a)
  const y = resolve(b)
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

/** The folders the agent is busy in: its main session's (its task's, else its own folder) and its parallel tasks'. */
function busyFolders(agentId: string) {
  const row = agentsRepo.get(agentId)
  const main = active.get(agentId)?.taskId ? tasksRepo.get(active.get(agentId)!.taskId!) : null
  const mainFolder = main ? taskFolder(main, agentId) : row?.cwd
  return [mainFolder, ...parallelTasks(agentId).map((t) => taskFolder(t, agentId))].filter((f): f is string => !!f)
}

/** Why this task can't run in a parallel session now (null: it can). Only asked when its agent is busy. */
export function parallelBlocker(task: OfficeTask, agentId: string): string | null {
  if (!task.parallel) return 'not marked parallel'
  const limit = officeSettings().parallelSessions
  if (!limit) return 'parallel sessions are off (Office settings)'
  if (parallelTasks(agentId).length >= limit) return `already ${limit} parallel session${limit > 1 ? 's' : ''} running`
  const folder = taskFolder(task, agentId)
  if (!folder) return 'no folder'
  if (busyFolders(agentId).some((f) => overlaps(f, folder))) return 'its folder overlaps the work already running'
  return null
}

/** Is the agent's main session busy (working, or with prompts waiting)? */
export const mainBusy = (agentId: string) => runtimeOf(agentId).status !== 'idle' || queueRepo.countFor(agentId) > 0

/** Wait for a new side session to be ready for a prompt (its SessionStart hook reported in). */
async function ready(agentId: string, key: string, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (sideRuntimeOf(agentId, key).status === 'idle') return true
    await Bun.sleep(500)
  }
  return false
}

/**
 * Run a task in a new session of the agent. Returns once the session exists; the prompt is typed when it's ready.
 * If it never gets ready, the task goes back to the queue of the main session.
 */
export async function startParallel(task: OfficeTask, agentId: string, prompt: string, fallback: () => Promise<unknown>) {
  const folder = taskFolder(task, agentId)
  // the folder first: the new session starts with it (--add-dir); the busy main session isn't typed into
  if (folder && folder !== agentsRepo.get(agentId)?.cwd) await grantFolder(agentId, folder, { live: false }).catch(() => {})
  const key = await openSideSession(agentId)
  renameSideSession(agentId, key, `Task: ${task.title}`)
  markTask(task.id, { agentId, sessionKey: key, status: 'in_progress', startedAt: Date.now() })
  addComment({ taskId: task.id, author: 'system', text: `${agentsRepo.get(agentId)?.name ?? 'The agent'} was busy: started in a parallel session (${key}).` })
  void (async () => {
    if (!(await ready(agentId, key))) throw new Error('the session did not start')
    await sendPrompt(agentId, prompt, key)
  })().catch(async (e) => {
    console.warn(`[parallel] ${task.title}: ${e instanceof Error ? e.message : e}; back to the queue`)
    markTask(task.id, { sessionKey: undefined, status: 'todo' })
    await closeSideSession(agentId, key).catch(() => {})
    await fallback().catch((err) => console.error('[parallel]', err))
  })
  return key
}

/** The line added to a parallel task's prompt: its turn's end is the task's end. */
export const PARALLEL_NOTE =
  'You are in a separate session next to your other work: stay in this task\'s folder. Finish in this one turn; if you start subagents, wait for their results before you end it.'

/** The end of a turn in a side session that runs a parallel task: its report, then the session closes. */
export function onParallelStopped(agentId: string, key: string, finalMessage: string | undefined, failed: boolean) {
  const t = taskInSession(agentId, key)
  if (!t) return false
  const ref: WorkRef & { title: string; startedAt: number; files?: Set<string> } = { taskId: t.id, title: t.title, startedAt: t.startedAt ?? Date.now(), files: filesOf.get(sid(agentId, key)) }
  filesOf.delete(sid(agentId, key))
  markTask(t.id, { sessionKey: undefined })
  const cmd = !failed ? checkFor(t) : undefined
  if (cmd) {
    // a failed check sends the fix to the agent's main session (queued while it's busy)
    markTask(t.id, { checkState: 'running' })
    const report = fileReport(agentId, ref, finalMessage, true, { forward: false })
    void runGate(t.id, agentId, cmd, report).catch((e) => console.error('[check]', e))
  } else {
    markTask(t.id, { status: 'review' })
    fileReport(agentId, ref, finalMessage, !failed)
  }
  // done: the session closes (its conversation stays listed, to read or open again)
  void closeSideSession(agentId, key).catch((e) => console.warn('[parallel] could not close', key, e.message))
  void tickTasks().catch((e) => console.error('[task]', e))
  return true
}

/** Files written in a parallel session: its report's attachments. */
const filesOf = new Map<string, Set<string>>()
const sid = (agentId: string, key: string) => `${agentId}:${key}`
export function noteParallelFile(agentId: string, key: string, path: string) {
  if (!taskInSession(agentId, key)) return
  const set = filesOf.get(sid(agentId, key)) ?? new Set<string>()
  if (set.size < 100) set.add(path)
  filesOf.set(sid(agentId, key), set)
}

/** A parallel session that's gone (closed by hand, crashed): its task goes back to To do. */
export function tidyParallel() {
  for (const t of tasksRepo.active()) {
    if (!t.sessionKey || !t.agentId) continue
    const side = sideSessionsRepo.get(t.agentId, t.sessionKey)
    if (side && !side.closed_at) continue
    markTask(t.id, { sessionKey: undefined, ...(t.status === 'in_progress' ? { status: 'todo' as const } : {}) })
    addComment({ taskId: t.id, author: 'system', text: 'Its parallel session closed before it finished. The task is back in To do.' })
  }
}
