import { Hono } from 'hono'
import { agentsRepo } from '../db'
import { AgentError } from '../agents/errors'
import { commitStaged, committedPaths, MAX_UPLOADS, withAttachments } from '../agents/uploads'
import { requestWho } from '../auth'
import { noteOwnerMessage } from '../work/activity'
import { cleanFolder } from '../work/folders'
import { cleanTagIds } from '../work/tags'
import { archiveThread, compactThread, createThread, editQueued, holdQueued, unsendQueued, reorderThreads, deleteThread, getThread, listThreads, markThreadRead, mentionTask, sendToThread, updateThread } from '../work/threads'

// /api/threads: the owner's topics with the manager (work/threads.ts). Every change reaches the dashboards as work state.

export const threadRoutes = new Hono()

threadRoutes.onError((err, c) => {
  if (err instanceof AgentError) return c.json({ error: err.message }, err.status)
  console.error(err)
  return c.json({ error: 'Something went wrong' }, 500)
})

threadRoutes.get('/threads', (c) => c.json(listThreads()))

threadRoutes.post('/threads', async (c) => {
  const b = await c.req.json<{ title?: unknown; folder?: unknown; tags?: unknown; text?: unknown; parentId?: unknown }>()
  const thread = await createThread({
    title: b.title,
    folder: cleanFolder(b.folder),
    tags: cleanTagIds(b.tags),
    // a sub-thread of this one (one level)
    ...(typeof b.parentId === 'string' && b.parentId ? { parentId: b.parentId } : {}),
  })
  // the first message, if any, goes in now (the manager's session is starting: it waits for it)
  if (typeof b.text === 'string' && b.text.trim()) {
    noteOwnerMessage(thread.managerId, requestWho(c))
    await sendToThread(thread.id, b.text.trim().slice(0, 50_000))
  }
  return c.json(getThread(thread.id))
})

// the list's order after a drag: siblings in their new order
threadRoutes.post('/threads/order', async (c) => {
  const b = await c.req.json<{ ids?: unknown }>()
  if (!Array.isArray(b.ids) || b.ids.length > 500 || !b.ids.every((x) => typeof x === 'string')) throw new AgentError('ids: the threads in their new order', 400)
  reorderThreads(b.ids as string[])
  return c.json({ ok: true })
})

threadRoutes.put('/threads/:id', async (c) => {
  const b = await c.req.json<{ title?: unknown; folder?: unknown; tags?: unknown; pinned?: unknown }>()
  return c.json(
    updateThread(c.req.param('id'), {
      ...(b.title !== undefined ? { title: b.title } : {}),
      ...(b.folder !== undefined ? { folder: cleanFolder(b.folder) ?? null } : {}),
      ...(b.tags !== undefined ? { tags: cleanTagIds(b.tags) ?? null } : {}),
      ...(typeof b.pinned === 'boolean' ? { pinned: b.pinned } : {}),
    }),
  )
})

// The owner's message: attachments (staged by /uploads) go into the manager's folder; each @mentioned agent gets the
// message as a task of its own, handed out on the manager's behalf (its report comes back to the thread).
threadRoutes.post('/threads/:id/messages', async (c) => {
  const t = getThread(c.req.param('id'))
  const b = await c.req.json<{ text?: unknown; uploads?: unknown; mentions?: unknown }>()
  const text = typeof b.text === 'string' ? b.text.slice(0, 50_000) : ''
  const ids = Array.isArray(b.uploads) ? b.uploads.filter((f): f is string => typeof f === 'string').slice(0, MAX_UPLOADS) : []
  if (!text.trim() && !ids.length) throw new AgentError('Write something first', 400)
  const manager = agentsRepo.get(t.managerId)
  if (!manager) throw new AgentError('The manager is gone', 409)
  const paths = committedPaths(ids.map((id) => commitStaged(manager, id)))
  const mentions = Array.isArray(b.mentions) ? [...new Set(b.mentions.filter((m): m is string => typeof m === 'string'))].slice(0, 5) : []
  const origin = { kind: 'owner' as const, label: `Thread "${t.title}"`, ...requestWho(c), at: Date.now() }
  const tasks = []
  for (const agentId of mentions) {
    const task = await mentionTask(t.id, agentId, withAttachments(text, paths), origin)
    if (task) tasks.push({ id: task.id, agentId })
  }
  // only mentions: the tasks are the message (the manager hears about each one)
  let queued = false
  if (!mentions.length || !tasks.length) {
    noteOwnerMessage(t.managerId, requestWho(c))
    queued = (await sendToThread(t.id, withAttachments(text, paths))) === 'queued'
  }
  return c.json({ ok: true, tasks, queued })
})

// the owner's queued message (still waiting for the manager): held while edited, edited, or taken back
threadRoutes.post('/threads/:id/queue/:qid/hold', async (c) => {
  const b = await c.req.json<{ held?: unknown }>()
  holdQueued(c.req.param('id'), c.req.param('qid'), b.held === true)
  return c.json({ ok: true })
})
threadRoutes.put('/threads/:id/queue/:qid', async (c) => {
  const b = await c.req.json<{ text?: unknown }>()
  editQueued(c.req.param('id'), c.req.param('qid'), typeof b.text === 'string' ? b.text : '')
  return c.json({ ok: true })
})
threadRoutes.delete('/threads/:id/queue/:qid', (c) => {
  unsendQueued(c.req.param('id'), c.req.param('qid'))
  return c.json({ ok: true })
})

// /compact in the thread's session (opened again first if it rests)
threadRoutes.post('/threads/:id/compact', async (c) => {
  const b = await c.req.json<{ focus?: unknown }>().catch(() => ({}) as { focus?: unknown })
  await compactThread(c.req.param('id'), typeof b.focus === 'string' ? b.focus.replace(/\s+/g, ' ').trim().slice(0, 300) : '')
  return c.json({ ok: true })
})

threadRoutes.post('/threads/:id/read', (c) => {
  markThreadRead(c.req.param('id'))
  return c.json({ ok: true })
})

threadRoutes.post('/threads/:id/archive', async (c) => c.json(await archiveThread(c.req.param('id'), true)))
threadRoutes.post('/threads/:id/unarchive', async (c) => c.json(await archiveThread(c.req.param('id'), false)))

threadRoutes.delete('/threads/:id', async (c) => {
  await deleteThread(c.req.param('id'))
  return c.json({ ok: true })
})
