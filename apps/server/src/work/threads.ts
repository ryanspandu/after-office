import type { OfficeTask, OfficeThread } from '@after-office/shared'
import { agentsRepo, sideSessionsRepo, tasksRepo, threadQueueRepo, threadsRepo } from '../db'
import { AgentError } from '../agents/errors'
import { closeSideSession, compactSession, forgetSideSession, openSideSession, renameSideSession, reopenSideSession, sendChat, sendPrompt } from '../agents/manager'
import { sideRuntimeOf } from '../agents/registry'
import { tmux } from '../agents/tmux'

// Threads: the owner's topics with the manager. Each runs in a side session of the manager's own, so it keeps the
// context of that topic only; tasks the manager starts there (or the owner's @mentions) belong to the thread and
// report back into it (task.managerSession). A thread's session closes when it has been quiet for a while (its memory
// comes back) and opens again, in the same conversation, when the owner writes or a report comes in.

/** How long a thread's session may sit idle before it's closed. */
export const THREAD_IDLE_MS = 30 * 60_000
/** How long to wait for a reopened session to be at its prompt. */
const READY_MS = 45_000

const publish = () => void import('./work').then((w) => w.publishWork('threads')).catch(() => {})

export const listThreads = () => threadsRepo.all().sort((a, b) => b.lastActivityAt - a.lastActivityAt)

export function getThread(id: string) {
  const t = threadsRepo.get(id)
  if (!t) throw new AgentError('No such thread', 404)
  return t
}

/** The thread a session of the manager runs (null: the main session, or an ordinary side session). */
export function threadOfSession(managerId: string, key?: string | null): OfficeThread | null {
  if (!key) return null
  const id = sideSessionsRepo.get(managerId, key)?.thread_id
  return id ? threadsRepo.get(id) : null
}

function save(t: OfficeThread) {
  threadsRepo.put(t)
  publish()
  return t
}

/** Something happened in it (a message, a task, a report): it moves to the top. */
export function touchThread(id: string | undefined, patch: Partial<OfficeThread> = {}) {
  const t = id ? threadsRepo.get(id) : null
  if (t) save({ ...t, ...patch, lastActivityAt: Date.now() })
}

const cleanTitle = (v: unknown) => {
  if (typeof v !== 'string' || !v.trim()) throw new AgentError('A thread needs a title', 400)
  return v.replace(/\s+/g, ' ').trim().slice(0, 80)
}

/**
 * The thread a new sub-thread goes under: the one asked for, or its own parent when that is itself a sub-thread (one
 * level only: a sub-thread of a sub-thread is its sibling).
 */
export function parentFor(id: string | undefined) {
  if (!id) return null
  const p = getThread(id)
  return p.parentId ? getThread(p.parentId) : p
}

export async function createThread(input: { title: unknown; folder?: string; tags?: string[]; parentId?: string }) {
  const manager = agentsRepo.manager()
  if (!manager) throw new AgentError('Threads are led by the manager: add one first', 409)
  const title = cleanTitle(input.title)
  // a sub-thread starts in its parent's folder and tags unless given its own
  const parent = parentFor(input.parentId)
  const folder = input.folder ?? parent?.folder
  const tags = input.tags?.length ? input.tags : parent?.tags
  const key = await openSideSession(manager.id)
  renameSideSession(manager.id, key, title)
  const now = Date.now()
  const t: OfficeThread = {
    id: `thr-${crypto.randomUUID().slice(0, 12)}`,
    title,
    managerId: manager.id,
    sessionKey: key,
    ...(parent ? { parentId: parent.id } : {}),
    ...(folder ? { folder } : {}),
    ...(tags?.length ? { tags } : {}),
    createdAt: now,
    lastActivityAt: now,
  }
  sideSessionsRepo.update(manager.id, key, { thread_id: t.id })
  if (parent) touchThread(parent.id)
  return save(t)
}

/** A thread's sub-threads, latest activity first. */
export const subThreads = (id: string) => listThreads().filter((t) => t.parentId === id)

export function updateThread(id: string, patch: { title?: unknown; folder?: string | null; tags?: string[] | null; pinned?: boolean }) {
  const t = getThread(id)
  const next: OfficeThread = { ...t }
  if (patch.title !== undefined) {
    next.title = cleanTitle(patch.title)
    if (sideSessionsRepo.get(t.managerId, t.sessionKey)) renameSideSession(t.managerId, t.sessionKey, next.title)
  }
  if (patch.folder !== undefined) {
    if (patch.folder) next.folder = patch.folder
    else delete next.folder
  }
  if (patch.pinned !== undefined) {
    if (patch.pinned) next.pinned = true
    else delete next.pinned
  }
  if (patch.tags !== undefined) {
    if (patch.tags?.length) next.tags = patch.tags
    else delete next.tags
  }
  return save(next)
}

/** The block the manager reads with the owner's first message in a thread (and after the topic's details change). */
export function threadContext(t: OfficeThread) {
  const parent = t.parentId ? threadsRepo.get(t.parentId) : null
  return [
    `[Thread: ${t.title}] You lead this thread: everything about this topic happens here.`,
    parent ? parentSummary(parent) : null,
    t.folder ? `Folder: ${t.folder}` : null,
    t.tags?.length ? `Tags: ${t.tags.join(', ')}` : null,
    'Delegate as usual: tasks you start here belong to this thread (its folder and tags unless you say otherwise) and report back here.',
  ]
    .filter(Boolean)
    .join('\n')
}

/** What a sub-thread's session is told about the thread it's part of: its topic, place, latest word and work. */
function parentSummary(p: OfficeThread) {
  const tasks = tasksRepo
    .active()
    .filter((x) => x.threadId === p.id)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, 8)
  const siblings = listThreads().filter((x) => x.parentId === p.id)
  return [
    `It is a sub-thread of "${p.title}" (thread id ${p.id}): stay on this part; the bigger picture is discussed there.`,
    p.lastMessage ? `Latest there: ${p.lastMessage}` : null,
    tasks.length ? `Its tasks: ${tasks.map((x) => `"${x.title}" (${x.status})`).join('; ')}` : null,
    siblings.length > 1 ? `Other parts: ${siblings.map((x) => `"${x.title}"`).join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

const isOpen = async (t: OfficeThread) => {
  const side = sideSessionsRepo.get(t.managerId, t.sessionKey)
  return !!side && !side.closed_at && (await tmux.hasSession(side.tmux_session))
}

const opening = new Map<string, Promise<void>>()

/** Its session running (opened again in the same conversation if it was closed). Resolves once it's at its prompt. */
export function ensureOpen(t: OfficeThread): Promise<void> {
  const busy = opening.get(t.id)
  if (busy) return busy
  const p = (async () => {
    if (await isOpen(t)) return
    if (!sideSessionsRepo.get(t.managerId, t.sessionKey)) throw new AgentError("This thread's session is gone", 409)
    await reopenSideSession(t.managerId, t.sessionKey)
    const until = Date.now() + READY_MS
    while (Date.now() < until) {
      if (sideRuntimeOf(t.managerId, t.sessionKey).status === 'idle') return
      await Bun.sleep(500)
    }
    throw new AgentError('The thread is still opening: send it again in a moment', 409)
  })().finally(() => opening.delete(t.id))
  opening.set(t.id, p)
  return p
}

/** The owner's message in a thread (with its attachments already in the text). */
export async function sendToThread(id: string, text: string) {
  const t = getThread(id)
  if (t.archivedAt) save({ ...t, archivedAt: undefined })
  await ensureOpen(t)
  const message = t.started ? text : `${threadContext(t)}\n\n${text}`
  await sendChat(t.managerId, message, t.sessionKey)
  touchThread(t.id, { started: true })
}

/**
 * Something for a thread's manager session (a report, an answer, the office's note): sent now if it's free, else
 * queued until it is. A closed session is opened again for it.
 */
export async function deliverToThread(t: OfficeThread, text: string) {
  touchThread(t.id)
  if (threadQueueRepo.countFor(t.id) === 0 && (await isOpen(t)) && sideRuntimeOf(t.managerId, t.sessionKey).status === 'idle') {
    await sendPrompt(t.managerId, text, t.sessionKey)
    return 'sent' as const
  }
  threadQueueRepo.add(t.id, text)
  void ensureOpen(t)
    .then(() => drainThreads())
    .catch((e) => console.warn(`[threads] could not open "${t.title}":`, e instanceof Error ? e.message : e))
  return 'queued' as const
}

const draining = new Set<string>()
/** Send each thread's oldest queued message once its session is free. On a timer, and when its turn ends. */
export async function drainThreads() {
  for (const t of threadsRepo.all()) {
    if (draining.has(t.id) || !threadQueueRepo.countFor(t.id)) continue
    if (sideRuntimeOf(t.managerId, t.sessionKey).status !== 'idle' || !(await isOpen(t))) continue
    const next = threadQueueRepo.next(t.id)
    if (!next) continue
    draining.add(t.id)
    try {
      threadQueueRepo.remove(next.id)
      await sendPrompt(t.managerId, next.text, t.sessionKey)
    } catch (e) {
      console.warn(`[threads] could not send to "${t.title}":`, e instanceof Error ? e.message : e)
    } finally {
      draining.delete(t.id)
    }
  }
}

/** The manager finished a turn in a thread: its answer is new for the owner. */
export function onThreadTurn(managerId: string, key: string, finalMessage?: string) {
  const t = threadOfSession(managerId, key)
  if (!t) return
  const ctx = sideRuntimeOf(managerId, key).contextPct
  touchThread(t.id, {
    unread: (t.unread ?? 0) + 1,
    ...(ctx != null ? { contextPct: ctx } : {}),
    ...(finalMessage?.trim() ? { lastMessage: finalMessage.replace(/\s+/g, ' ').trim().slice(0, 200) } : {}),
  })
  void drainThreads()
}

export function markThreadRead(id: string) {
  const t = getThread(id)
  if (t.unread) save({ ...t, unread: 0 })
}

/** Since when each thread's session has been idle with nothing waiting for it (reset on a server restart). */
const idleSince = new Map<string, number>()

/** Close the sessions of threads quiet for THREAD_IDLE_MS: their memory comes back; they open again when needed. */
export async function closeIdleThreads(now = Date.now(), idleMs = THREAD_IDLE_MS) {
  for (const t of threadsRepo.all()) {
    const side = sideSessionsRepo.get(t.managerId, t.sessionKey)
    if (!side || side.closed_at || opening.has(t.id)) {
      idleSince.delete(t.id)
      continue
    }
    const rt = sideRuntimeOf(t.managerId, t.sessionKey)
    const quiet = rt.status === 'idle' && !rt.compactingSince && !threadQueueRepo.countFor(t.id)
    if (!quiet) {
      idleSince.delete(t.id)
      continue
    }
    const since = idleSince.get(t.id) ?? now
    idleSince.set(t.id, since)
    if (now - since < idleMs) continue
    idleSince.delete(t.id)
    // its context as last seen: shown while it rests
    if (rt.contextPct != null && rt.contextPct !== t.contextPct) threadsRepo.put({ ...t, contextPct: rt.contextPct })
    await closeSideSession(t.managerId, t.sessionKey).catch(() => {})
    console.log(`[threads] "${t.title}" was quiet: its session closed (the conversation is kept)`)
  }
}

export async function archiveThread(id: string, archived: boolean): Promise<OfficeThread> {
  const t = getThread(id)
  // a thread put away takes its sub-threads with it (and brings them back)
  for (const c of subThreads(t.id)) if (!!c.archivedAt !== archived) await archiveThread(c.id, archived)
  if (archived) {
    const side = sideSessionsRepo.get(t.managerId, t.sessionKey)
    if (side && !side.closed_at) await closeSideSession(t.managerId, t.sessionKey).catch(() => {})
  }
  return save({ ...t, archivedAt: archived ? Date.now() : undefined })
}

/** Gone for good: its session and conversation are forgotten. Its tasks and reports stay (still marked with it). */
export async function deleteThread(id: string) {
  const t = getThread(id)
  const side = sideSessionsRepo.get(t.managerId, t.sessionKey)
  if (side && !side.closed_at) await closeSideSession(t.managerId, t.sessionKey).catch(() => {})
  if (side) forgetSideSession(t.managerId, t.sessionKey)
  // its sub-threads stay, as threads of their own
  for (const c of subThreads(t.id)) {
    const { parentId: _, ...rest } = c
    threadsRepo.put(rest)
  }
  threadQueueRepo.removeThread(t.id)
  threadsRepo.remove(t.id)
  publish()
}

/**
 * The owner @mentioned an agent in a thread: a task for that agent right away, handed out on the manager's behalf, so
 * its report comes back to the thread's manager session (who follows up as usual).
 */
export async function mentionTask(id: string, agentId: string, text: string, origin: OfficeTask['origin']) {
  const t = getThread(id)
  const agent = agentsRepo.get(agentId)
  if (!agent || agent.id === t.managerId) return null
  const firstLine = text.trim().split('\n')[0] ?? ''
  const task: OfficeTask = {
    id: `task-${crypto.randomUUID().slice(0, 12)}`,
    title: (firstLine || `From the thread "${t.title}"`).slice(0, 200),
    description: `From the thread "${t.title}" (the owner asked you directly):\n\n${text.trim()}`.slice(0, 20_000),
    agentId: agent.id,
    ...(t.folder ? { folder: t.folder } : {}),
    ...(t.tags?.length ? { tags: t.tags } : {}),
    deadline: Date.now() + 24 * 3_600_000,
    priority: 'medium',
    status: 'todo',
    delegatedBy: t.managerId,
    managerSession: t.sessionKey,
    threadId: t.id,
    origin,
  }
  tasksRepo.put(task)
  const w = await import('./work')
  w.addComment({ taskId: task.id, author: 'user', text: `Asked for in the thread "${t.title}".` })
  w.publishWork('tasks')
  const result = await w.startTask(task.id)
  await deliverToThread(
    t,
    `[After Office] The owner gave ${agent.name} a task from this thread (task id ${task.id}): "${task.title}". It ${result === 'sent' ? 'started' : 'is queued'}; its report comes here: follow up on it as usual.`,
  ).catch(() => {})
  touchThread(t.id)
  return task
}

/**
 * A task the manager makes: in a thread (its session), or after a task of one, it belongs to that thread, with the
 * thread's folder and tags unless the manager gave its own.
 */
export function joinThread(task: OfficeTask, managerId: string, session: string | undefined, after: string[] = []) {
  const t = threadOfSession(managerId, session) ?? after.map((id) => tasksRepo.get(id)?.threadId).map((id) => (id ? threadsRepo.get(id) : null)).find((x) => !!x) ?? null
  if (!t) return task
  task.threadId = t.id
  if (!task.folder && t.folder) task.folder = t.folder
  if (!task.tags?.length && t.tags?.length) task.tags = t.tags
  touchThread(t.id)
  return task
}

/**
 * The owner dragged threads into a new order: `ids` are siblings (top-level threads, or one thread's sub-threads) in
 * their new order. Others keep theirs. Not a write per thread for nothing: only the ones whose place changed.
 */
export function reorderThreads(ids: string[]) {
  const list = ids.map((id) => threadsRepo.get(id)).filter((t): t is OfficeThread => !!t)
  if (!list.length) return
  const parent = list[0].parentId ?? null
  if (list.some((t) => (t.parentId ?? null) !== parent)) throw new AgentError('Threads can only move among their siblings', 400)
  list.forEach((t, i) => {
    if (t.order !== i) threadsRepo.put({ ...t, order: i })
  })
  publish()
}

/** Compact a thread's conversation (Claude Code's /compact): its session is opened again first if it rests. */
export async function compactThread(id: string, focus = '') {
  const t = getThread(id)
  await ensureOpen(t)
  await compactSession(t.managerId, t.sessionKey, focus)
}
