import { cpus, freemem, totalmem } from 'node:os'
import { requestWho } from '../auth'
import { noteOwnerMessage } from '../work/activity'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { FollowUpDecision, LiveMode } from '@after-office/shared'
import { agentsRepo, sideSessionsRepo, usageRepo, tasksRepo } from '../db'
import { existsSync } from 'node:fs'
import { active, cleanChatContext, contextBlock, expectChatReport, withContext, stopActiveTask } from '../work/work'
import { decide } from '../agents/ingest'
import { AgentError, changeFolder, compactSession, createAgent, deleteAgent, interrupt, restartAgent, sendPrompt, setMode, revokeFolder, randomStyle, grantFolder, sessionKeyOf, openSideSession, closeSideSession, reopenSideSession, forgetSideSession, renameSideSession } from '../agents/manager'
import { currentRateLimits, snapshot, subscribe, toInfo, updateRuntime, updateSideRuntime, runtimeOf, sideRuntimeOf } from '../agents/registry'
import type { Runtime } from '../agents/state'
import { readChat } from '../agents/transcripts'
import { requireSameOrigin, terminalSocket } from '../agents/term'
import { requireUnlockedTerminal } from '../agents/termLock'
import { readProfile, writeProfile, type ProfileDoc } from '../agents/profile'
import { accountSkill, accountSkillList } from '../agents/accountSkills'
import { agentFile, agentFiles, fileResponse } from '../agents/files'
import { tmux } from '../agents/tmux'
import { restartAgentServer, restartWhenIdle } from '../agents/reconciler'
import { listSecrets, putSecret, removeSecret } from '../agents/secrets'
import { applyRules, cleanPacks, rulesIn } from '../agents/rules'
import { readInFolder, writeInFolder } from '../agents/safefs'
import { join } from 'node:path'
import { generateKey, putIdentity, removeIdentity, removeKey, setGitIdentity, toIdentity, uploadKey, writeGitConfig } from '../agents/git'
import { ISOLATED } from '../agents/env'
import { commitStaged, discardStaged, MAX_UPLOAD_BYTES, MAX_UPLOADS, stageUpload, withAttachments } from '../agents/uploads'
import { listConnectors, listConnectorTools, setAgentConnectors } from '../agents/connectors'
import { countEntries, deleteAgentFolder, isOwnAgentFolder } from '../work/projectFolders'

// /api routes for live agents. Mounted behind requireAuth + requireJsonForWrites in index.ts.

export const agentRoutes = new Hono()

agentRoutes.onError((err, c) => {
  if (err instanceof AgentError) return c.json({ error: err.message }, err.status)
  console.error(err)
  return c.json({ error: 'Something went wrong' }, 500)
})

agentRoutes.get('/agents', (c) => c.json(agentsRepo.all().map((row) => toInfo(row))))

agentRoutes.post('/agents', async (c) => {
  const body = await c.req.json()
  const row = await createAgent(body)
  return c.json(toInfo(row), 201)
})

/** Can the agent's folder go with it (its own one in the agents' folder), and how much is in it. */
agentRoutes.get('/agents/:id/folder', (c) => {
  const row = agentsRepo.get(c.req.param('id'))
  if (!row) throw new AgentError('No such agent', 404)
  const deletable = isOwnAgentFolder(row)
  return c.json({ folder: row.cwd, deletable, entries: deletable ? countEntries(row.cwd) : 0 })
})
agentRoutes.delete('/agents/:id', async (c) => {
  const row = agentsRepo.get(c.req.param('id'))
  // ?folder=1: its own folder goes too (decided before the agent is gone, deleted after its session stopped)
  const folder = row && c.req.query('folder') === '1' ? (isOwnAgentFolder(row) ? row.cwd : null) : null
  if (row && c.req.query('folder') === '1' && !folder) throw new AgentError("This agent's folder can't be deleted here (it isn't its own folder in the agents' folder)", 400)
  await deleteAgent(c.req.param('id'))
  if (folder) await deleteAgentFolder(folder)
  return c.json({ ok: true })
})

agentRoutes.post('/agents/:id/prompt', async (c) => {
  const { text, uploads, folder: folderIn, tags, join } = await c.req.json<{ text: string; uploads?: unknown; folder?: unknown; tags?: unknown; join?: unknown }>()
  // ?session=s2: one of its side sessions (unset: its main session)
  const key = sessionKeyOf(c.req.query('session'))
  // the folder and tags picked above the message box (optional): a block after the owner's words (work/chatContext.ts)
  const ctx = cleanChatContext(folderIn, tags)
  // attached files (staged by /uploads): moved into the agent's folder now, listed at the end of the message
  const ids = Array.isArray(uploads) ? uploads.filter((f): f is string => typeof f === 'string').slice(0, MAX_UPLOADS) : []
  const row = ids.length ? agentsRepo.get(c.req.param('id')) : null
  if (ids.length && !row) throw new AgentError('No such agent', 404)
  // offline: say so before moving anything (the files stay attached for another try)
  if (row && !(await tmux.hasSession(key ? (sideSessionsRepo.get(row.id, key)?.tmux_session ?? '') : row.tmux_session))) throw new AgentError(key ? 'That session is not running' : 'The agent is offline', 409)
  const paths = row ? ids.map((id) => commitStaged(row, id).path) : []
  const id = c.req.param('id')
  const block = contextBlock(id, ctx)
  const message = withAttachments(withContext(String(text ?? ''), block), paths)
  const agent = agentsRepo.get(id)
  if (block && agent && agent.kind !== 'manager') {
    // a folder outside its own: the agent may work there (no permission prompts)
    const folder = ctx.folder
    if (folder && existsSync(folder) && folder !== agent.cwd) await grantFolder(id, folder).catch((e) => console.warn(`[chat] could not add ${folder} for ${id}:`, e.message))
    // its answer to this message is kept in Reports
    expectChatReport(id, message, String(text ?? ''), ctx, key)
  }
  // the Activity log: this turn is the owner's, from this device
  noteOwnerMessage(id, requestWho(c))
  // a follow-up right after the owner's last message (the dashboard says so) while the agent is still answering that
  // one: its answer is stopped and this goes in now, so one answer covers both (Claude Code would otherwise keep it
  // for after, a second answer). Never over a task or a daily run: those finish first.
  const rt = key ? sideRuntimeOf(id, key) : runtimeOf(id)
  const onTask = key ? tasksRepo.active().some((t) => t.agentId === id && t.sessionKey === key && t.status === 'in_progress') : active.has(id)
  const joined = join === true && rt.status === 'working' && !onTask
  if (joined) await interrupt(id, key)
  await sendPrompt(id, message, key)
  return c.json({ ok: true, joined })
})

// Compact the conversation (Claude Code's /compact: it's summarized, which frees the context window). Only while the
// agent is idle: a turn in progress would take the command as its next message, and a task would be cut into.
agentRoutes.post('/agents/:id/compact', async (c) => {
  const id = c.req.param('id')
  const key = sessionKeyOf(c.req.query('session'))
  const body = await c.req.json<{ focus?: unknown }>().catch(() => ({}) as { focus?: unknown })
  // what to keep in mind while summarizing (optional): one short line
  const focus = typeof body.focus === 'string' ? body.focus.replace(/\s+/g, ' ').trim().slice(0, 300) : ''
  await compactSession(id, key, focus)
  return c.json({ ok: true })
})

// a file attached in the chat (one per request: raw bytes, its name URL-encoded in X-File-Name). Only staged: it goes
// into the agent's folder when the message is sent, and is deleted if it's removed or never sent
agentRoutes.post('/agents/:id/uploads', requireSameOrigin, async (c) => {
  const row = agentsRepo.get(c.req.param('id'))
  if (!row) throw new AgentError('No such agent', 404)
  let name = 'file'
  try {
    name = decodeURIComponent(c.req.header('x-file-name') ?? '') || 'file'
  } catch {
    // not URL-encoded: use as is
    name = c.req.header('x-file-name') ?? 'file'
  }
  if (Number(c.req.header('content-length') ?? 0) > MAX_UPLOAD_BYTES) throw new AgentError(`${name} is bigger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`, 413)
  const data = new Uint8Array(await c.req.arrayBuffer())
  if (!data.byteLength) throw new AgentError(`${name} is empty`)
  return c.json(stageUpload(row.id, name, data))
})
agentRoutes.delete('/agents/:id/uploads/:upload', (c) => {
  discardStaged(c.req.param('id'), c.req.param('upload'))
  return c.json({ ok: true })
})

agentRoutes.post('/agents/:id/mode', async (c) => {
  const { mode } = await c.req.json<{ mode: LiveMode }>()
  return c.json(await setMode(c.req.param('id'), mode, sessionKeyOf(c.req.query('session'))))
})

agentRoutes.post('/agents/:id/model', async (c) => {
  const { model } = await c.req.json<{ model: string }>()
  const row = await restartAgent(c.req.param('id'), { model })
  return c.json(toInfo(row))
})

// thinking effort: restarts the session with `--effort` (conversation kept); null = Claude Code's default
agentRoutes.post('/agents/:id/effort', async (c) => {
  const { effort } = await c.req.json<{ effort?: string | null }>().catch(() => ({ effort: undefined }))
  const row = await restartAgent(c.req.param('id'), { effort: effort ?? null })
  return c.json(toInfo(row))
})

agentRoutes.post('/agents/:id/folder', async (c) => {
  const { cwd } = await c.req.json<{ cwd?: string }>()
  return c.json(toInfo(await changeFolder(c.req.param('id'), String(cwd ?? ''))))
})

// take a project folder away from an agent (it restarts, conversation kept)
agentRoutes.delete('/agents/:id/dirs', async (c) => {
  const b = await c.req.json<{ dir?: string }>().catch(() => ({}) as { dir?: string })
  if (typeof b.dir !== 'string' || !b.dir) throw new AgentError('Which folder?')
  return c.json(toInfo(await revokeFolder(c.req.param('id'), b.dir)))
})
agentRoutes.post('/agents/:id/restart', async (c) => c.json(toInfo(await restartAgent(c.req.param('id')))))

// its git identities and SSH keys (Overview → Git). Its session reads its own gitconfig on every git run, so a change
// applies at once; a session started before it had one is restarted once it's idle (conversation kept).
const gitChanged = async (id: string) => {
  const row = agentsRepo.get(id)
  if (!row) return
  await writeGitConfig(row).catch((e) => console.error('[git]', e instanceof Error ? e.message : e))
  updateRuntime(id, (rt) => ({ ...rt }))
  if ((await tmux.hasSession(row.tmux_session)) && (await tmux.sessionEnv(row.tmux_session, 'GIT_CONFIG_GLOBAL')) === null) restartWhenIdle(id)
}
const agentRow = (id: string) => {
  const row = agentsRepo.get(id)
  if (!row) throw new AgentError('No such agent', 404)
  return row
}
const identityParam = (c: { req: { query: (k: string) => string | undefined } }) => c.req.query('identity') || undefined
agentRoutes.put('/agents/:id/git', async (c) => {
  const b = await c.req.json<{ name?: unknown; email?: unknown }>().catch(() => ({}) as { name?: unknown; email?: unknown })
  setGitIdentity(agentRow(c.req.param('id')), b.name, b.email)
  await gitChanged(c.req.param('id'))
  return c.json(toInfo(agentRow(c.req.param('id'))))
})
agentRoutes.post('/agents/:id/git/identities', async (c) => {
  const g = putIdentity(agentRow(c.req.param('id')), null, await c.req.json().catch(() => ({})))
  await gitChanged(c.req.param('id'))
  return c.json(toIdentity(g))
})
agentRoutes.put('/agents/:id/git/identities/:gid', async (c) => {
  const g = putIdentity(agentRow(c.req.param('id')), c.req.param('gid'), await c.req.json().catch(() => ({})))
  await gitChanged(c.req.param('id'))
  return c.json(toIdentity(g))
})
agentRoutes.delete('/agents/:id/git/identities/:gid', async (c) => {
  await removeIdentity(agentRow(c.req.param('id')), c.req.param('gid'))
  await gitChanged(c.req.param('id'))
  return c.json({ ok: true })
})
// secrets (Overview → Secrets): tokens for its projects' services, as environment variables of its sessions.
// Write-only (names and last 4 characters come back, never values); a change restarts it once it's idle.
agentRoutes.get('/agents/:id/secrets', (c) => c.json(listSecrets(agentRow(c.req.param('id')).id)))
agentRoutes.put('/agents/:id/secrets', async (c) => {
  const row = agentRow(c.req.param('id'))
  const b = await c.req.json<{ name?: unknown; value?: unknown }>().catch(() => ({}) as { name?: unknown; value?: unknown })
  const info = putSecret(row.id, b.name, b.value)
  restartWhenIdle(row.id)
  return c.json(info)
})
agentRoutes.delete('/agents/:id/secrets/:name', (c) => {
  const row = agentRow(c.req.param('id'))
  removeSecret(row.id, c.req.param('name'))
  restartWhenIdle(row.id)
  return c.json({ ok: true })
})
// SSH keys: the default identity's, or ?identity=<id> for an extra one
agentRoutes.post('/agents/:id/ssh/generate', async (c) => {
  const key = await generateKey(agentRow(c.req.param('id')), identityParam(c))
  await gitChanged(c.req.param('id'))
  return c.json(key)
})
agentRoutes.put('/agents/:id/ssh', async (c) => {
  const { privateKey } = await c.req.json<{ privateKey?: unknown }>().catch(() => ({ privateKey: undefined }))
  const key = await uploadKey(agentRow(c.req.param('id')), privateKey, identityParam(c))
  await gitChanged(c.req.param('id'))
  return c.json(key)
})
agentRoutes.delete('/agents/:id/ssh', async (c) => {
  await removeKey(agentRow(c.req.param('id')), identityParam(c))
  await gitChanged(c.req.param('id'))
  return c.json({ ok: true })
})

// office rules in its CLAUDE.md (CLAUDE.md tab → Office rules): which sets it has, and set them. Only the marked
// blocks change; the agent reads CLAUDE.md at session start, so it's restarted once it's idle (conversation kept)
agentRoutes.get('/agents/:id/rules', (c) => {
  const row = agentRow(c.req.param('id'))
  return c.json({ packs: rulesIn(readInFolder(row.cwd, join(row.cwd, 'CLAUDE.md')) ?? '') })
})
agentRoutes.put('/agents/:id/rules', async (c) => {
  const row = agentRow(c.req.param('id'))
  if (row.kind === 'manager') throw new AgentError("The manager's CLAUDE.md has its own rules", 400)
  const { packs } = await c.req.json<{ packs?: unknown }>().catch(() => ({ packs: undefined }))
  const file = join(row.cwd, 'CLAUDE.md')
  const next = applyRules(readInFolder(row.cwd, file) ?? '', cleanPacks(packs))
  writeInFolder(row.cwd, file, next)
  restartWhenIdle(row.id)
  return c.json({ packs: rulesIn(next), claudeMd: next })
})

// the agents' tmux server: can it start sessions (a broken one makes every restarted agent exit at once), and restart it
agentRoutes.get('/agents-server', async (c) => c.json({ canStartSessions: await tmux.canStartSessions(), isolated: ISOLATED }))
agentRoutes.post('/agents-server/restart', async (c) => c.json({ restarted: await restartAgentServer() }))

// the user looked at the Chat tab: clear the unread badge
agentRoutes.post('/agents/:id/read', (c) => {
  const key = sessionKeyOf(c.req.query('session'))
  const read = (rt: Runtime) => (rt.unread ? { ...rt, unread: 0 } : rt)
  if (key) updateSideRuntime(c.req.param('id'), key, read)
  else updateRuntime(c.req.param('id'), read)
  return c.json({ ok: true })
})

agentRoutes.post('/agents/:id/interrupt', async (c) => {
  const key = sessionKeyOf(c.req.query('session'))
  await interrupt(c.req.param('id'), key)
  // stopped partway through a task: it goes back to To do now (Resume picks it up), not when the next message comes
  const task = stopActiveTask(c.req.param('id'), { author: 'user' }, undefined, key)
  return c.json({ ok: true, ...(task ? { task: { id: task.id, title: task.title } } : {}) })
})

// ── side sessions: more chats with the same agent, each its own Claude Code process (agents/manager.ts) ──
agentRoutes.post('/agents/:id/sessions', async (c) => c.json({ key: await openSideSession(c.req.param('id')) }))
// closing stops its process; the conversation stays, to open again
agentRoutes.delete('/agents/:id/sessions/:key', async (c) => {
  await closeSideSession(c.req.param('id'), c.req.param('key'))
  return c.json({ ok: true })
})
agentRoutes.put('/agents/:id/sessions/:key', async (c) => {
  const b = await c.req.json<{ name?: unknown }>().catch(() => ({}) as { name?: unknown })
  renameSideSession(c.req.param('id'), c.req.param('key'), typeof b.name === 'string' ? b.name : '')
  return c.json({ ok: true })
})
agentRoutes.post('/agents/:id/sessions/:key/reopen', async (c) => c.json({ key: await reopenSideSession(c.req.param('id'), c.req.param('key')) }))
agentRoutes.delete('/agents/:id/sessions/:key/forget', (c) => {
  forgetSideSession(c.req.param('id'), c.req.param('key'))
  return c.json({ ok: true })
})

// ── attachments: files an agent made or pointed to (agents/files.ts decides what may be shown) ──
agentRoutes.post('/agents/:id/files/stat', async (c) => {
  const row = agentsRepo.get(c.req.param('id'))
  if (!row) throw new AgentError('No such agent', 404)
  const b = await c.req.json<{ paths?: unknown }>().catch(() => ({}) as { paths?: unknown })
  const paths = Array.isArray(b.paths) ? b.paths.filter((p): p is string => typeof p === 'string').slice(0, 100) : []
  return c.json(agentFiles(row, paths, 100))
})
agentRoutes.get('/agents/:id/file', (c) => {
  const row = agentsRepo.get(c.req.param('id'))
  const f = row ? agentFile(row, c.req.query('path') ?? '') : null
  if (!f) return c.json({ error: 'Not a file this agent can share' }, 404)
  return fileResponse(f.real, f.size, c.req.query('inline') === '1')
})

// skills from the Claude account (every agent has them); read-only
agentRoutes.get('/account-skills', (c) => c.json(accountSkillList()))
agentRoutes.get('/account-skills/:id', (c) => {
  const s = accountSkill(c.req.param('id'))
  return s ? c.json(s) : c.json({ error: 'No such skill' }, 404)
})
agentRoutes.get('/agents/:id/profile', (c) => c.json(readProfile(c.req.param('id'))))
// connectors: the Claude account's MCP servers, and which ones each agent may use (default none)
agentRoutes.get('/connectors', async (c) => c.json(await listConnectors({ fresh: c.req.query('fresh') === '1' })))
// their tools, split into reading and writing (Read / Write in an agent's Connectors tab)
agentRoutes.get('/connectors/tools', async (c) => c.json(await listConnectorTools({ fresh: c.req.query('fresh') === '1' })))
agentRoutes.put('/agents/:id/connectors', async (c) => {
  const id = c.req.param('id')
  const { allowed, write, readAsk } = await c.req
    .json<{ allowed?: unknown; write?: unknown; readAsk?: unknown }>()
    .catch(() => ({ allowed: undefined, write: undefined, readAsk: undefined }))
  const list = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string')
  if (!list(allowed)) throw new AgentError('allowed: a list of connectors')
  if (write !== undefined && !list(write)) throw new AgentError('write: a list of connectors')
  if (readAsk !== undefined && !list(readAsk)) throw new AgentError('readAsk: a list of connectors')
  await setAgentConnectors(id, allowed as string[], write as string[] | undefined, readAsk as string[] | undefined)
  updateRuntime(id, (rt) => ({ ...rt })) // the new list goes out to the dashboards
  return c.json({ ok: true })
})

// pinned to the top of the agents list, on every device
agentRoutes.put('/agents/:id/pin', async (c) => {
  const id = c.req.param('id')
  if (!agentsRepo.get(id)) throw new AgentError('No such agent', 404)
  const { pinned } = await c.req.json<{ pinned?: unknown }>().catch(() => ({ pinned: undefined }))
  agentsRepo.update(id, { pinned: pinned === true ? 1 : 0 })
  updateRuntime(id, (rt) => ({ ...rt }))
  return c.json({ ok: true })
})

// its character in the office (woman / man); shown right away on every dashboard
agentRoutes.put('/agents/:id/figure', async (c) => {
  const id = c.req.param('id')
  if (!agentsRepo.get(id)) throw new AgentError('No such agent', 404)
  const { figure } = await c.req.json<{ figure?: unknown }>().catch(() => ({ figure: undefined }))
  if (figure !== 'man' && figure !== 'woman' && figure !== null) throw new AgentError('Choose man or woman')
  agentsRepo.update(id, { figure: figure as string | null })
  updateRuntime(id, (rt) => ({ ...rt })) // the changed figure goes out to the dashboards
  return c.json({ ok: true })
})
// a new random look for its character (same figure): "Shuffle look" in its profile
agentRoutes.post('/agents/:id/style', (c) => {
  const id = c.req.param('id')
  if (!agentsRepo.get(id)) throw new AgentError('No such agent', 404)
  const style = randomStyle()
  agentsRepo.update(id, { style })
  updateRuntime(id, (rt) => ({ ...rt }))
  return c.json({ style })
})
agentRoutes.put('/agents/:id/profile', async (c) => c.json(writeProfile(c.req.param('id'), await c.req.json<ProfileDoc>())))

// the terminal: keys straight into its session, so only once the terminals are unlocked with the code (agents/termLock.ts)
agentRoutes.get('/agents/:id/term', requireSameOrigin, requireUnlockedTerminal, terminalSocket)

agentRoutes.get('/agents/:id/chat', (c) => {
  const row = agentsRepo.get(c.req.param('id'))
  if (!row) return c.json({ error: 'No such agent' }, 404)
  const limit = Math.min(500, Number(c.req.query('limit') ?? 200) || 200)
  return c.json(readChat(row, limit, sessionKeyOf(c.req.query('session'))))
})

agentRoutes.post('/followups/:id/decision', async (c) => {
  await decide(c.req.param('id'), await c.req.json<FollowUpDecision>(), requestWho(c))
  return c.json({ ok: true })
})

agentRoutes.get('/usage', (c) => {
  const from = c.req.query('from') ?? '0000-01-01'
  const to = c.req.query('to') ?? '9999-12-31'
  return c.json(usageRepo.range(from, to))
})

// Live feed: a snapshot on connect, then every change. A ping every 10 s keeps proxies from closing the stream
// and lets the dashboard notice a dead one.
agentRoutes.get('/events', (c) =>
  streamSSE(c, async (stream) => {
    const queue: string[] = [JSON.stringify(snapshot())]
    let wake: (() => void) | null = null
    const unsubscribe = subscribe((e) => {
      queue.push(JSON.stringify(e))
      wake?.()
    })
    stream.onAbort(() => {
      unsubscribe()
      wake?.()
    })
    let lastBeat = Date.now()
    while (!stream.aborted) {
      while (queue.length) await stream.writeSSE({ event: 'office', data: queue.shift()! })
      // the dashboard reconnects if it hears nothing for a while (a proxy can keep a dead stream open)
      if (Date.now() - lastBeat > 10_000) {
        await stream.writeSSE({ event: 'ping', data: String(Date.now()) })
        lastBeat = Date.now()
      }
      await new Promise<void>((r) => {
        wake = r
        setTimeout(r, 10_000)
      })
      wake = null
    }
    unsubscribe()
  }),
)

// Host CPU / RAM for the navbar. CPU % is measured between consecutive calls.
let lastCpu = cpus().map((c) => c.times)
agentRoutes.get('/system', (c) => {
  const now = cpus().map((c) => c.times)
  let idle = 0
  let total = 0
  now.forEach((t, i) => {
    const p = lastCpu[i] ?? t
    const d = (k: keyof typeof t) => t[k] - p[k]
    idle += d('idle')
    total += d('user') + d('nice') + d('sys') + d('irq') + d('idle')
  })
  lastCpu = now
  const gb = (b: number) => Math.round((b / 1024 ** 3) * 10) / 10
  // macOS counts file cache as used; freemem is conservative but consistent
  return c.json({
    cpu: total ? Math.round(((total - idle) / total) * 100) : 0,
    memUsedGb: gb(totalmem() - freemem()),
    memTotalGb: gb(totalmem()),
    // also here (polled every few seconds), so the plan meter recovers even if an SSE event was missed
    rateLimits: currentRateLimits(),
  })
})
