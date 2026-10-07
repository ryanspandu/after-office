import type { Context } from 'hono'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { DEFAULT_MODEL, divisionOf, MODEL_CHOICES, RULE_PACKS, type OfficeTask, type RulePackId } from '@after-office/shared'
import { agentsRepo, commentsRepo, connectorsOf, cronsRepo, queueRepo, reportsRepo, tasksRepo, type AgentRow } from './db'
import { knownConnectors, listConnectors } from './agents/connectors'
import { diffSince } from './work/git'
import { AgentError, interrupt, restartAgent, sessionKeyOf } from './agents/manager'
import { restartWhenIdle } from './agents/reconciler'
import { requestHire } from './work/hires'
import { bossMode, countBoss } from './work/settings'
import { logSystem, noteManagerMessage } from './work/activity'
import { runtimeOf } from './agents/registry'
import { jobNamed } from './work/jobs'
import { statusLabel } from './work/statuses'
import { stopActiveTask, markTask, isReadingAgentOutput, managerReviseTask, MAX_MANAGER_REVISIONS, addComment, assignTask, checkFor, taskFolder, deliver, delegateTask, expectReply, managerDeleteTask, managerUpdateTask, notifyUser, retagReports, quotaPause, waitingOn, changeCron, cronFrom, pendingCronChanges, timezone, parallelBlocker, ownerTask } from './work/work'
import { listTags, tagIdsByName, tagNames } from './work/tags'
import { cleanFolder } from './work/folders'
import { agentDeleteNote, agentEditNote, agentNotes, agentReadNote, agentWriteNote, noteForAgent } from './work/notes'
import { cleanPacks } from './agents/rules'

// The after-office MCP server: the manager agent's hands. Its Claude Code session reaches it over loopback
// (.mcp.json written by writeManagerFiles), authenticated like the hooks (HOOK_TOKEN + X-AO-Agent). Every tool just
// calls the same server functions the dashboard uses; nothing here calls a model.
//
// Stateless Streamable HTTP: a fresh server per request, so each call knows which agent is asking.

type Text = { content: { type: 'text'; text: string }[]; isError?: boolean }
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] })
const fail = (e: unknown): Text => ({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true })
const json = (v: unknown) => text(JSON.stringify(v, null, 2))

const iso = (ms?: number) => (ms ? new Date(ms).toISOString() : undefined)
/** restart_agent: when the manager last restarted each agent (at most once every RESTART_EVERY_MS: no restart loops) */
const lastRestart = new Map<string, number>()
const RESTART_EVERY_MS = 10 * 60_000

/** Connector names an agent may use ("all" for agents set up before connectors were managed). */
function connectorNames(a: AgentRow) {
  const allowed = connectorsOf(a)
  if (allowed === null) return 'all'
  const byPrefix = new Map(knownConnectors().map((c) => [c.prefix, c.name]))
  return allowed.map((p) => byPrefix.get(p) ?? p)
}

/** Names (or prefixes) the manager gave → known connector prefixes; unknown ones are ignored. */
function connectorPrefixes(names?: string[]) {
  if (!names?.length) return undefined
  const known = knownConnectors()
  return names
    .map((n) => known.find((c) => c.name.toLowerCase() === n.trim().toLowerCase() || c.prefix === n.trim())?.prefix)
    .filter((p): p is string => !!p)
}


async function changedFiles(t: OfficeTask) {
  const cwd = taskFolder(t)
  if (!t.gitBase || !cwd) return undefined
  const d = await diffSince(cwd, t.gitBase)
  return d.files?.slice(0, 60).map((f) => ({ path: f.path, status: f.status, added: f.additions, removed: f.deletions }))
}

function describeTask(t: OfficeTask, withTimeline = false) {
  const report = reportsRepo.latest(1000).find((r) => r.kind === 'task' && r.refId === t.id)
  const waiting = waitingOn(t)
  return {
    id: t.id,
    title: t.title,
    agent: t.forOwner ? 'the owner (their own task)' : t.agentId ? (agentsRepo.get(t.agentId)?.name ?? t.agentId) : null,
    agentId: t.agentId,
    status: t.status,
    ...(t.customStatus ? { shownAs: statusLabel(t.status, t.customStatus) } : {}),
    priority: t.priority,
    deadline: iso(t.deadline),
    delegatedByYou: !!t.delegatedBy,
    folder: t.folder ?? null,
    tags: t.tags?.length ? tagNames(t.tags) : undefined,
    waitingForOwnerApproval: t.awaitingApproval || undefined,
    qualityCheck: checkFor(t) ? { command: checkFor(t), state: t.checkState ?? 'not run yet', fixRounds: t.checkAttempts ?? 0 } : undefined,
    waitsFor: t.blockedBy?.length ? t.blockedBy : undefined,
    stillWaitingFor: waiting.length ? waiting.map((w) => ({ id: w.id, title: w.title, status: w.status })) : undefined,
    latestReport: report ? { ok: report.ok, finishedAt: iso(report.finishedAt), text: report.text } : null,
    timeline: withTimeline
      ? commentsRepo
          .forTask(t.id)
          .filter((c) => c.kind !== 'report') // the report is above
          .slice(-30)
          .map((c) => ({ at: iso(c.createdAt), from: c.author === 'user' ? 'owner' : c.agentId ? (agentsRepo.get(c.agentId)?.name ?? c.author) : c.author, kind: c.kind ?? 'note', text: c.text }))
      : undefined,
  }
}

/** An agent by id, or by name (case-insensitive), for the manager's convenience. Never the manager itself. */
function resolveAgent(ref: string, managerId: string) {
  const key = ref.trim()
  const row = agentsRepo.get(key) ?? agentsRepo.all().find((a) => a.name.toLowerCase() === key.toLowerCase())
  if (!row) throw new AgentError(`No agent "${ref}"; call list_agents for names and ids`, 404)
  if (row.id === managerId) throw new AgentError('That is you; pick another agent')
  return row
}

function buildServer(managerId: string, session = '') {
  const me = agentsRepo.get(managerId)
  const server = new McpServer(
    { name: 'after-office', version: '1.0.0' },
    {
      instructions:
        `Tools of the After Office dashboard. You are ${me?.name ?? 'the manager'}, the general manager: every other agent ` +
        'works for you, grouped into divisions by role. Delegate to any active agent with delegate_task and report back to ' +
        'the owner in chat. Finished work arrives in chat as "[After Office] Report from …".',
    },
  )

  server.registerTool(
    'list_agents',
    {
      description:
        'Everyone who works for you, grouped by division (their role): id, name, status (idle = free, working, waiting = ' +
        'needs the owner, offline = cannot take work), model, folder, what they are doing, queued prompts.',
      inputSchema: {
        division: z.string().optional().describe('only this division (case-insensitive)'),
        onlyActive: z.boolean().optional().describe('leave out offline agents'),
      },
    },
    async ({ division, onlyActive }) => {
      const want = division?.trim().toLowerCase()
      const agents = agentsRepo
        .all()
        .filter((a) => a.id !== managerId)
        .map((a) => {
          const rt = runtimeOf(a.id)
          return {
            id: a.id,
            name: a.name,
            division: divisionOf(a.role),
            status: rt.status,
            available: rt.status !== 'offline',
            waitingFor: rt.waitingFor,
            model: rt.modelName ?? a.model,
            effort: a.effort ?? 'default',
            folder: a.cwd,
            doing: rt.task,
            queuedPrompts: queueRepo.countFor(a.id),
            // the account's connectors it may use (Gmail, Drive, …): hand work that needs one to someone who has it
            connectors: connectorNames(a),
          }
        })
        .filter((a) => (!want || a.division.toLowerCase() === want) && (!onlyActive || a.available))
      if (!agents.length)
        return text(want || onlyActive ? 'Nobody matches that. Call list_agents without filters to see everyone.' : 'There are no other agents yet. Ask the owner to add some in the dashboard.')
      const divisions = [...new Set(agents.map((a) => a.division))].sort()
      const paused = quotaPause()
      return json({
        summary: `${agents.filter((a) => a.available).length} of ${agents.length} active, ${divisions.length} division(s)`,
        ...(paused ? { quotaBrake: `${paused}: new tasks are created but start only when usage drops` } : {}),
        divisions: divisions.map((d) => ({ division: d, agents: agents.filter((a) => a.division === d).map(({ division: _, ...a }) => a) })),
      })
    },
  )

  server.registerTool(
    'delegate_task',
    {
      description:
        'Give an agent a task. It is typed into their Claude Code session now (or queued until they are free) and tracked in ' +
        'the dashboard. When they finish, their report arrives in your chat. One clear goal per task, with what "done" means.',
      inputSchema: {
        agent: z.string().describe('agent id or name from list_agents'),
        title: z.string().min(1).max(200).describe('short task title'),
        description: z.string().min(1).max(20_000).describe('what to do, where, and what done looks like'),
        priority: z.enum(['low', 'medium', 'high']).optional(),
        deadlineHours: z.number().positive().max(24 * 60).optional().describe('hours from now; default 24'),
        mode: z.enum(['default', 'acceptEdits', 'auto']).optional().describe("permission mode for this task; default: the agent's current mode"),
        folder: z.string().max(1000).optional().describe("absolute path of the folder to work in (an agent's folder, a repo, or one in the office's folder); the agent is given access when the task starts. Unset: the agent's own folder"),
        after: z
          .array(z.string())
          .max(20)
          .optional()
          .describe('task ids this one waits for; it starts on its own once they are finished (use it to chain steps, e.g. build → test)'),
        tags: z.array(z.string().max(40)).max(10).optional().describe('tag names the owner made (see list_tags), e.g. ["SEO"]; only existing tags'),
        job: z
          .string()
          .max(120)
          .optional()
          .describe(
            "the owner's request this task is a step of, as a short name (e.g. \"Artikel TV Stand\"). Give every step of the same request the same name (write, review, revise, review again): the owner sees them as one item instead of a report per step. A task with `after` joins the job of the task it waits for on its own",
          ),
        parallel: z
          .boolean()
          .optional()
          .describe(
            'if the agent is busy, start it now in a separate session of theirs instead of queueing it. Only when the owner allows parallel sessions, under their limit per agent, and when this task\'s folder is not one the agent is already working in (else it is queued as usual). Use it for urgent or independent work in another folder; it costs extra plan usage',
          ),
      },
    },
    async ({ agent, title, description, priority, deadlineHours, mode, after, folder, tags, parallel, job }) => {
      try {
        const target = resolveAgent(agent, managerId)
        const out = await delegateTask(managerId, {
          agent: target.id,
          after,
          folder: folder ?? null,
          tags: tagIdsByName(tags),
          parallel,
          job,
          title,
          description,
          priority,
          mode,
          managerSession: session,
          deadline: deadlineHours ? Date.now() + deadlineHours * 3_600_000 : undefined,
        })
        const delivery =
          out.result === 'sent'
            ? 'sent now'
            : out.result === 'parallel'
              ? 'the agent was busy: started now in a parallel session of theirs (it closes when the task is done)'
            : out.result === 'queued'
              ? 'queued until the agent is free'
              : out.result === 'waiting'
                ? `waits for: ${out.waitingFor.join(', ')}; starts on its own when they are finished${parallel ? ` (in a parallel session if ${target.name} is busy then)` : ` (queued behind ${target.name}'s other work if they are busy then; pass parallel: true to run it next to it)`}`
                : out.result === 'approval'
                  ? "waiting for the owner's approval in the dashboard; if they reject it you get a message"
                  : `on hold: ${out.paused}; starts on its own when usage drops`
        const boss = bossMode()
        // asked for a parallel session but queued: why
        const notParallel = parallel && out.result === 'queued' ? parallelBlocker(out.task, target.id) : null
        return json({ taskId: out.task.id, agent: target.name, division: divisionOf(target.role), delivery, ...(out.task.job ? { job: out.task.job.title } : {}), ...(notParallel ? { parallelNotUsed: notParallel } : {}), ...(boss ? { bossMode: `on until ${new Date(boss.until).toISOString()}: started without approval` } : {}) })
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'message_agent',
    {
      description: 'Send a short follow-up message to an agent (typed into their session, or queued if they are busy). Not tracked as a task; their answer comes back to you as an [After Office] message.',
      inputSchema: { agent: z.string().describe('agent id or name'), text: z.string().min(1).max(10_000) },
    },
    async ({ agent, text: body }) => {
      try {
        const target = resolveAgent(agent, managerId)
        // injection guard (work.ts): a message typed straight into an agent could carry what a report slipped in
        if (isReadingAgentOutput(managerId) && !bossMode())
          return fail(new Error("Right after an agent's report, messages to agents are off. To have the reporting agent redo its task, use send_back_task; otherwise tell the owner what you'd send, or make it a task with delegate_task (the owner approves it)."))
        noteManagerMessage(target.id, managerId)
        const result = await deliver(target.id, `[From the manager] ${body}`)
        countBoss('messages')
        if (target.id !== managerId) expectReply(target.id, managerId, session)
        return text(result === 'sent' ? `Sent to ${target.name}.` : `${target.name} is busy; queued.`)
      } catch (e) {
        return fail(e)
      }
    },
  )

  // stopping work partway: the agent stops (like Esc in its terminal); a task it was on goes back to To do, marked
  // stopped (Resume picks it up), with a note saying the manager stopped it and why
  const stopWork = async (target: AgentRow, reason: string, key = '') => {
    await interrupt(target.id, key)
    const task = stopActiveTask(target.id, { author: 'manager', agentId: managerId }, reason, key)
    logSystem(target.id, `Stopped by the manager: ${reason}`)
    return task
  }
  // right after an agent's report, no stopping agents (an injected report mustn't be able to halt the office)
  const stopRefused = () =>
    isReadingAgentOutput(managerId) && !bossMode()
      ? fail(new Error("Right after an agent's report, stopping agents is off. Tell the owner what you'd stop and why, or wait for your next turn."))
      : null

  server.registerTool(
    'interrupt_agent',
    {
      description:
        "Stop what an agent is doing right now (like pressing Esc in its terminal): for one going the wrong way, looping, or working on something that's no longer wanted. Its conversation stays. A task it was on goes back to To do, marked stopped (the owner can Resume it, or you can send it again). Not yourself. Say why; tell the owner.",
      inputSchema: {
        agent: z.string().describe('agent id or name'),
        reason: z.string().min(3).max(300).describe('why, in a few words (shown on the task and in its activity log)'),
      },
    },
    async ({ agent, reason }) => {
      try {
        const target = resolveAgent(agent, managerId)
        if (target.id === managerId) return fail(new Error("You can't interrupt yourself."))
        const refused = stopRefused()
        if (refused) return refused
        const status = runtimeOf(target.id).status
        if (status !== 'working' && status !== 'waiting') return text(`${target.name} isn't working right now (${status}); nothing to stop.`)
        const task = await stopWork(target, reason)
        return text(`${target.name} stopped.${task ? ` Its task "${task.title}" is back in To do (stopped; it can be resumed).` : ''}`)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'stop_task',
    {
      description:
        "Stop a task that's in progress and put it back in To do: its agent stops (conversation kept), the task is marked stopped, so it can be resumed later or sent again. For work that's no longer wanted now, or must wait. Say why; tell the owner.",
      inputSchema: {
        task: z.string().describe('task id'),
        reason: z.string().min(3).max(300).describe('why, in a few words (shown on the task)'),
      },
    },
    async ({ task: taskId, reason }) => {
      try {
        const t = tasksRepo.get(taskId)
        if (!t) return fail(new Error('No such task'))
        if (t.status !== 'in_progress') return fail(new Error(`That task isn't in progress (it's ${statusLabel(t.status, t.customStatus)}).`))
        if (!t.agentId || !agentsRepo.get(t.agentId)) return fail(new Error('That task has no agent.'))
        if (t.agentId === managerId) return fail(new Error("That's your own task."))
        const refused = stopRefused()
        if (refused) return refused
        const stopped = await stopWork(agentsRepo.get(t.agentId)!, reason, t.sessionKey ?? '')
        // its agent wasn't really on it any more (no run tracked): still back to To do
        if (!stopped || stopped.id !== t.id) {
          if (tasksRepo.get(t.id)?.status === 'in_progress') {
            markTask(t.id, { status: 'todo', stoppedAt: Date.now() })
            addComment({ taskId: t.id, author: 'manager', agentId: managerId, kind: 'note', text: `Stopped by the manager (${reason}). Back in To do.` })
          }
        }
        return text(`"${t.title}" stopped and back in To do.`)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'restart_agent',
    {
      description:
        "Restart an agent's Claude Code session (its conversation is kept: it resumes where it was). For an agent that's stuck, frozen, looping, or needs its CLAUDE.md / skills / settings read again. A busy agent restarts once it's idle, unless `now` (that stops what it's doing). Not yourself; the same agent at most once every 10 minutes. Tell the owner why.",
      inputSchema: {
        agent: z.string().describe('agent id or name'),
        reason: z.string().min(3).max(300).describe('why, in a few words (shown in its activity log)'),
        now: z.boolean().optional().describe('restart even if it is working (it stops mid-task); default: once it is idle'),
      },
    },
    async ({ agent, reason, now }) => {
      try {
        const target = resolveAgent(agent, managerId)
        if (target.id === managerId) return fail(new Error("You can't restart your own session. Ask the owner (agent drawer → Restart session)."))
        const last = lastRestart.get(target.id) ?? 0
        if (Date.now() - last < RESTART_EVERY_MS)
          return fail(new Error(`${target.name} was restarted less than 10 minutes ago. Give it time, or tell the owner it still looks stuck.`))
        // injection guard (as for message_agent): right after an agent's report, no stopping an agent mid-work
        if (now && isReadingAgentOutput(managerId) && !bossMode())
          return fail(new Error("Right after an agent's report, restarting an agent mid-work is off. Leave out `now` (it restarts once idle), or tell the owner."))
        const status = runtimeOf(target.id).status
        if (status === 'offline') {
          lastRestart.set(target.id, Date.now())
          await restartAgent(target.id)
          logSystem(target.id, `Started again by the manager: ${reason}`)
          return text(`${target.name} was offline; starting it again (conversation kept).`)
        }
        const busy = status === 'working' || status === 'waiting'
        lastRestart.set(target.id, Date.now())
        if (busy && !now) {
          restartWhenIdle(target.id)
          logSystem(target.id, `Restart asked by the manager (once idle): ${reason}`)
          return text(`${target.name} is ${status}; it restarts once it's idle (conversation kept).`)
        }
        await restartAgent(target.id)
        logSystem(target.id, `Restarted by the manager${busy ? ' (it was busy)' : ''}: ${reason}`)
        return text(`${target.name} restarted (conversation kept).${busy ? ' It was busy: what it was doing stopped; check its task and send it on if needed.' : ''}`)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'list_tasks',
    {
      description: 'Tasks in the dashboard (newest first), optionally filtered, with each one’s latest report.',
      inputSchema: {
        status: z.enum(['todo', 'in_progress', 'review', 'done']).optional(),
        agent: z.string().optional().describe('agent id or name'),
        onlyDelegatedByMe: z.boolean().optional(),
        tag: z.string().optional().describe('only tasks with this tag (name)'),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ status, agent: ref, onlyDelegatedByMe, tag, limit }) => {
      let agent: string | undefined
      let tagId: string | undefined
      try {
        agent = ref ? resolveAgent(ref, managerId).id : undefined
        tagId = tag ? tagIdsByName([tag])?.[0] : undefined
      } catch (e) {
        return fail(e)
      }
      const tasks = tasksRepo
        .all()
        .filter((t) => (!status || t.status === status) && (!agent || t.agentId === agent) && (!onlyDelegatedByMe || t.delegatedBy === managerId) && (!tagId || !!t.tags?.includes(tagId)))
        .reverse()
        .slice(0, limit ?? 20)
      return tasks.length ? json(tasks.map((t) => describeTask(t))) : text('No matching tasks.')
    },
  )

  server.registerTool(
    'get_task',
    {
      description:
        'One task with its full latest report, quality check result, what it waits for, its timeline (owner notes, revision requests) and the files its agent changed since it started.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const t = tasksRepo.get(id)
      return t ? json({ ...describeTask(t, true), changedFiles: await changedFiles(t) }) : fail(new Error(`No task ${id}`))
    },
  )

  server.registerTool(
    'list_tags',
    {
      description: "The owner's tags (labels for tasks and reports). Use them in delegate_task / update_task and to filter list_tasks / list_reports. You can't create tags; ask the owner.",
      inputSchema: {},
    },
    async () => {
      const tags = listTags()
      return tags.length ? json(tags.map((t) => ({ name: t.name, color: t.color }))) : text('No tags yet (the owner makes them in the dashboard).')
    },
  )

  server.registerTool(
    'list_reports',
    {
      description: 'Recent reports (task results and daily-job runs), newest first: id, the job and task they belong to, tags. tag_reports changes their tags.',
      inputSchema: {
        sinceHours: z.number().positive().max(24 * 30).optional(),
        tag: z.string().optional().describe('only reports with this tag (name)'),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ sinceHours, tag, limit }) => {
      const since = sinceHours ? Date.now() - sinceHours * 3_600_000 : 0
      let tagId: string | undefined
      try {
        tagId = tag ? tagIdsByName([tag])?.[0] : undefined
      } catch (e) {
        return fail(e)
      }
      const reports = reportsRepo
        .latest(200)
        .filter((r) => r.finishedAt >= since && r.kind !== 'note' && (!tagId || !!r.tags?.includes(tagId)))
        .slice(0, limit ?? 15)
        .map((r) => ({ id: r.id, kind: r.kind, title: r.title, job: r.job?.title, taskId: r.kind === 'task' ? r.refId : undefined, agent: agentsRepo.get(r.agentId)?.name, ok: r.ok, finishedAt: iso(r.finishedAt), tags: tagNames(r.tags), text: r.text }))
      return reports.length ? json(reports) : text('No reports in that window.')
    },
  )

  server.registerTool(
    'tag_reports',
    {
      description:
        "Add tags to, or take tags off, reports already filed. A task's tags are copied onto its reports when they're " +
        'filed, so a tag given to a task later only reaches its new reports: use this for the old ones (e.g. every ' +
        'report of a job). Pick them by id (list_reports), by job name (every report of that job), or by task id. ' +
        "Tags by name (list_tags); you can't create tags.",
      inputSchema: {
        ids: z.array(z.string()).max(500).optional().describe('report ids'),
        job: z.string().optional().describe('every report of the job with this name (as given in delegate_task)'),
        taskIds: z.array(z.string()).max(100).optional().describe('every report of these tasks'),
        add: z.array(z.string()).optional().describe('tag names to add'),
        remove: z.array(z.string()).optional().describe('tag names to take off'),
      },
    },
    async ({ ids, job, taskIds, add, remove }) => {
      try {
        if (!ids?.length && !job?.trim() && !taskIds?.length) return text('Say which reports: ids, job or taskIds.')
        if (!add?.length && !remove?.length) return text('Say which tags to add or remove.')
        const addIds = tagIdsByName(add) ?? []
        const removeIds = tagIdsByName(remove) ?? []
        const jobName = job?.trim().toLowerCase()
        const picked = reportsRepo
          .latest(1000)
          .filter((r) => ids?.includes(r.id) || (!!jobName && r.job?.title.toLowerCase() === jobName) || (r.kind === 'task' && !!taskIds?.includes(r.refId)))
          .map((r) => r.id)
        if (!picked.length) return text('No report matches that (check list_reports for ids and job names).')
        const changed = retagReports(picked, addIds, removeIds)
        return text(`${picked.length} report${picked.length === 1 ? '' : 's'} matched; ${changed} changed${changed < picked.length ? ' (the rest already had those tags)' : ''}.`)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'list_connectors',
    {
      description:
        "The Claude account's connectors (Gmail, Google Drive, …) and whether each is connected. Agents only use the ones the owner turned on for them (list_agents shows each agent's).",
      inputSchema: {},
    },
    async () => {
      const { list } = await listConnectors()
      return json(list.map((c) => ({ name: c.name, status: c.status, source: c.source })))
    },
  )

  // ── daily jobs: the same approval rules as delegate_task (work/managerCrons.ts) ──
  const dailyAgent = (ref: string) => {
    const key = ref.trim()
    const row = agentsRepo.get(key) ?? agentsRepo.all().find((a) => a.name.toLowerCase() === key.toLowerCase())
    if (!row) throw new AgentError(`No agent "${ref}"; call list_agents for names and ids`, 404)
    return row
  }
  const findCron = (ref: string) => {
    const key = ref.trim().toLowerCase()
    const c = cronsRepo.get(ref.trim()) ?? cronsRepo.all().find((x) => x.name.toLowerCase() === key)
    if (!c) throw new AgentError(`No daily job "${ref}"; see list_daily_jobs`, 404)
    return c
  }
  const dayNumbers = (days?: string[]) => {
    if (!days) return undefined
    const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
    return days.map((d) => names.indexOf(d.trim().toLowerCase().slice(0, 3))).filter((n) => n >= 0)
  }
  const applied = (result: 'applied' | 'approval', what: string) =>
    result === 'applied' ? `${what}: done.` : `${what}: waiting for the owner's approval in the dashboard; if they reject it you get a message.`
  const DAYS = z.array(z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])).min(1).max(7)
  const TIMES = z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1).max(24)

  server.registerTool(
    'list_daily_jobs',
    {
      description: `Daily jobs (recurring prompts typed into an agent's session on a schedule, office timezone ${timezone()}), and your changes still waiting for the owner.`,
      inputSchema: {},
    },
    async () => {
      try {
        const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
        return json({
          jobs: cronsRepo.all().map((c) => ({
            id: c.id,
            name: c.name,
            agent: c.agentId ? (agentsRepo.get(c.agentId)?.name ?? c.agentId) : null,
            times: c.times,
            days: c.days.map((d) => names[d]),
            enabled: c.enabled,
            freshContext: !!c.fresh,
            prompt: c.prompt,
            lastRuns: c.lastRuns?.slice(-3),
          })),
          waiting: pendingCronChanges(),
        })
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'create_daily_job',
    {
      description:
        "Set up a daily job: this prompt is typed into the agent's Claude Code session at these times on these days (office " +
        'timezone), and its result comes back as a report. For recurring work only; one-off work is delegate_task.',
      inputSchema: {
        name: z.string().min(1).max(120).describe('short name, e.g. "Morning SEO check"'),
        agent: z.string().describe('agent id or name from list_agents (may be you)'),
        prompt: z.string().min(1).max(20_000).describe('what the agent does each run, and what its report should say'),
        times: TIMES.describe('times of day, "HH:MM" 24h, e.g. ["09:00"]'),
        days: DAYS.optional().describe('days of the week; default every day'),
        freshContext: z.boolean().optional().describe('start each run with /clear (a clean context); default false'),
      },
    },
    async ({ name, agent, prompt, times, days, freshContext }) => {
      try {
        const cron = cronFrom({
          name,
          prompt,
          times,
          days: dayNumbers(days) ?? [0, 1, 2, 3, 4, 5, 6],
          agentId: dailyAgent(agent).id,
          fresh: !!freshContext,
          enabled: true,
        })
        return text(`${applied(changeCron(managerId, { action: 'create', cron }), `Daily job "${cron.name}" (id ${cron.id})`)}`)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'update_daily_job',
    {
      description: 'Change a daily job: only the fields you give change (e.g. enabled:false pauses it).',
      inputSchema: {
        job: z.string().describe('daily job id or name from list_daily_jobs'),
        name: z.string().min(1).max(120).optional(),
        agent: z.string().optional().describe('agent id or name'),
        prompt: z.string().min(1).max(20_000).optional(),
        times: TIMES.optional(),
        days: DAYS.optional(),
        freshContext: z.boolean().optional(),
        enabled: z.boolean().optional().describe('false pauses it, true runs it again'),
      },
    },
    async ({ job, name, agent, prompt, times, days, freshContext, enabled }) => {
      try {
        const previous = findCron(job)
        const cron = cronFrom(
          {
            name,
            prompt,
            times,
            days: dayNumbers(days),
            agentId: agent ? dailyAgent(agent).id : undefined,
            fresh: freshContext,
            enabled,
          },
          previous,
        )
        return text(applied(changeCron(managerId, { action: 'update', cron, previous }), `Daily job "${cron.name}"`))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'delete_daily_job',
    {
      description: 'Remove a daily job for good (to pause it, update_daily_job with enabled:false).',
      inputSchema: { job: z.string().describe('daily job id or name from list_daily_jobs') },
    },
    async ({ job }) => {
      try {
        const previous = findCron(job)
        return text(applied(changeCron(managerId, { action: 'delete', previous }), `Deleting "${previous.name}"`))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'assign_task',
    {
      description: 'Give an unassigned task (one the office asked you about) to an agent. It starts on its own unless it still waits for other tasks.',
      inputSchema: { task: z.string().describe('task id'), agent: z.string().describe('agent id or name') },
    },
    async ({ task, agent }) => {
      try {
        const target = resolveAgent(agent, managerId)
        const result = await assignTask(managerId, task, target.id)
        return text(`${target.name} has it (${result}).`)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'create_agent',
    {
      description:
        'Propose hiring a new agent (a new Claude Code session). The owner approves it in the dashboard first; you get a ' +
        'message either way. Its role is its division. Only when no active agent fits the work.',
      inputSchema: {
        name: z.string().min(1).max(32).describe('first name, e.g. "Nova"'),
        role: z.string().min(1).max(60).describe('role = division, e.g. "Engineering", "QA", "Research"'),
        brief: z.string().max(10_000).optional().describe('standing instructions for the agent (its CLAUDE.md)'),
        model: z.enum(MODEL_CHOICES).optional().describe('default claude-sonnet-5-5 (Sonnet 5.5, the newest Sonnet); opus the most capable, sonnet = Sonnet 5, haiku fast & cheap'),
        permissionMode: z.enum(['default', 'acceptEdits', 'plan', 'auto']).optional().describe("default: auto (works without stopping for permission prompts, the owner's choice for new hires); 'default' asks before risky actions"),
        folder: z.string().max(300).optional().describe('working folder, e.g. a repo it should work on; default ~/after-office/<name>'),
        connectors: z
          .array(z.string().max(120))
          .max(40)
          .optional()
          .describe('connectors it needs (names from list_connectors, e.g. "claude.ai Google Drive"). Default: none. The owner sees and can change them before approving.'),
        effort: z
          .enum(['low', 'medium', 'high', 'xhigh', 'max'])
          .optional()
          .describe("how hard it thinks. Unset: Claude Code's default, right for most work. low/medium: quick, light work (summaries, tidying, short replies); high: research, debugging, design; xhigh/max only for the hardest work: higher uses the owner's plan much faster. The owner can change it before approving."),
        rules: z
          .array(z.enum(RULE_PACKS.map((p) => p.id) as [RulePackId, ...RulePackId[]]))
          .optional()
          .describe("office rules for its CLAUDE.md: 'office' is always included; add 'engineering' for an agent that writes code (per-project runtimes and services, preview ports). Default: by its role. The owner can change them before approving."),
        figure: z
          .enum(['woman', 'man'])
          .describe(
            "its character in the office (always set it): one that fits the name you give it (e.g. Lena, Sari, Maya → woman; Raka, Budi, Leo → man), or what the owner said (\"a female secretary\", \"cewek\"), which wins. The owner can change it before approving.",
          ),
      },
    },
    async ({ name, role, brief, model, permissionMode, folder, figure, connectors, effort, rules }) => {
      try {
        const h = requestHire(managerId, { name, role, brief, model: model ?? DEFAULT_MODEL, mode: permissionMode ?? 'auto', folder, figure, effort, ...(rules ? { rules: cleanPacks(rules) } : {}), connectors: connectorPrefixes(connectors) })
        return json({ status: "waiting for the owner's approval", name: h.name, division: divisionOf(h.role), folder: h.folder })
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'update_task',
    {
      description:
        'Edit a task: title, description, priority, deadline, agent, folder, what it waits for, quality check, or status ' +
        '(todo / review / done; "done" accepts it). Tasks in progress can only get text/priority/deadline changes. Changes show on its timeline.',
      inputSchema: {
        task: z.string().describe('task id'),
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(20_000).optional(),
        priority: z.enum(['low', 'medium', 'high']).optional(),
        deadlineHours: z.number().positive().max(24 * 60).optional().describe('new deadline, hours from now'),
        status: z.enum(['todo', 'review', 'done']).optional(),
        agent: z.string().optional().describe('agent id or name; "none" to unassign'),
        folder: z.string().max(1000).optional().describe('absolute path of the folder to work in; "none" for the agent\'s own'),
        after: z.array(z.string()).max(20).optional().describe('task ids it waits for (replaces the list; [] = none)'),
        tags: z.array(z.string().max(40)).max(10).optional().describe('tag names (replaces the list; [] = none); ' + 'tag names the owner made (see list_tags), e.g. ["SEO"]; only existing tags'),
        check: z
          .string()
          .max(1000)
          .optional()
          .describe('quality check command for this task (runs in the agent\'s folder when it finishes); a new command waits for the owner\'s approval; "" clears it'),
        parallel: z
          .boolean()
          .optional()
          .describe('run it in a parallel session when its agent is busy (same rules as in delegate_task). A task already queued behind the agent\'s other work starts in one now; also used when it starts after the tasks it waits for, and for send_back_task'),
      },
    },
    async ({ task, title, description, priority, deadlineHours, status, agent, folder, after, check, tags, parallel }) => {
      try {
        const none = (v?: string) => v !== undefined && /^(none|null|)$/i.test(v.trim())
        const t = await managerUpdateTask(managerId, task, {
          title,
          description,
          priority,
          deadline: deadlineHours ? Date.now() + deadlineHours * 3_600_000 : undefined,
          status,
          agentId: agent === undefined ? undefined : none(agent) ? null : resolveAgent(agent, managerId).id,
          folder: folder === undefined ? undefined : none(folder) ? null : folder,
          blockedBy: after,
          check,
          tags: tags === undefined ? undefined : (tagIdsByName(tags) ?? []),
          parallel,
        })
        return json(describeTask(t))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'delete_task',
    {
      description: "Remove a task (not while it is in progress). Queued prompts for it are dropped. If it was the owner's task, they are told.",
      inputSchema: { task: z.string().describe('task id') },
    },
    async ({ task }) => {
      try {
        const t = managerDeleteTask(managerId, task)
        return text(`Deleted "${t.title}".`)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'send_back_task',
    {
      description:
        `Send finished work back to the agent who did it for another round, with clear feedback: same task, same agent. Works right after its report (unlike delegate_task and message_agent), for the task that report is about. At most ${MAX_MANAGER_REVISIONS} rounds in a row; then ask the owner.`,
      inputSchema: { task: z.string().describe('task id (from the report)'), feedback: z.string().min(1).max(10_000).describe('what to change, concretely') },
    },
    async ({ task, feedback }) => {
      try {
        const result = await managerReviseTask(managerId, task, feedback)
        return text(
          result === 'sent'
            ? 'Sent back for another round.'
            : result === 'parallel'
              ? 'The agent is busy: the round runs now in a parallel session of theirs.'
              : 'Queued: the agent is busy; it gets the feedback next (update_task parallel: true first runs such rounds next to their work).',
        )
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'give_owner_task',
    {
      description:
        "Give the owner a task of their own: something only they can do (approve or publish something, log in somewhere, upload a file, make a decision). It shows on their list under \"For you\" and is tracked like any task; agents' tasks can wait for it with delegate_task's `after`. Don't use it for work an agent can do.",
      inputSchema: {
        title: z.string().min(1).max(200).describe('what they need to do, short'),
        description: z.string().max(20_000).optional().describe('why, and what done looks like'),
        priority: z.enum(['low', 'medium', 'high']).optional(),
        deadlineHours: z.number().positive().max(24 * 60).optional().describe('hours from now; default 24'),
        folder: z.string().max(1000).optional().describe('absolute path of the folder it is about'),
        after: z.array(z.string()).max(20).optional().describe('task ids that should be finished first'),
        tags: z.array(z.string().max(40)).max(10).optional().describe('tag names the owner made (see list_tags)'),
        job: z.string().max(120).optional().describe("the owner's request this is a step of (the same name as its other tasks)"),
      },
    },
    async ({ title, description, priority, deadlineHours, folder, after, tags, job }) => {
      try {
        const t = ownerTask(managerId, { title, description, priority, folder, after, job, tags: tagIdsByName(tags), deadline: deadlineHours ? Date.now() + deadlineHours * 3_600_000 : undefined, managerSession: session })
        return json({ taskId: t.id, for: 'the owner', status: t.status, ...(t.job ? { job: t.job.title } : {}) })
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'comment_task',
    {
      description: "Add a note to a task's timeline in the dashboard (decisions, progress, why you sent it back). The owner sees it on the task.",
      inputSchema: { task: z.string().describe('task id'), text: z.string().min(1).max(10_000) },
    },
    async ({ task, text: body }) => {
      if (!tasksRepo.get(task)) return fail(new Error(`No task ${task}; see list_tasks`))
      addComment({ taskId: task, author: 'manager', agentId: managerId, text: body })
      return text('Added to the task timeline.')
    },
  )

  server.registerTool(
    'notify_user',
    {
      description:
        'Put a note in the dashboard’s Reports (unread badge, and a push notification to their phone if set up), for things the owner should see even if they are not reading this chat. When it is about the work in a folder, give `folder`: the note then also shows in that folder\'s reports. One note per outcome: if you already told the owner this (e.g. another report of the same work came in), don\'t repeat it.',
      inputSchema: {
        title: z.string().min(1).max(200),
        text: z.string().min(1).max(20_000),
        folder: z.string().max(1000).optional().describe('absolute path of the folder the note is about'),
        tags: z.array(z.string().max(40)).max(10).optional().describe("tag names the owner made (see list_tags), e.g. [\"SEO\"]; only existing tags"),
        job: z.string().max(120).optional().describe('the job this note sums up (the same name you gave its tasks in delegate_task): it is shown with that work'),
        outcome: z
          .enum(['done', 'pass', 'revise', 'failed', 'needs_you'])
          .optional()
          .describe('how it turned out, shown as a badge: done (finished), pass (approved in review), revise (needs another round), failed, needs_you (the owner has to decide or act)'),
      },
    },
    async ({ title, text: body, folder, tags, job, outcome }) => {
      try {
        const where = cleanFolder(folder)
        notifyUser(managerId, title, body, tagIdsByName(tags), where, job ? jobNamed(job) : undefined, outcome)
        return text(where ? `Posted to Reports, with the folder ${where}.` : 'Posted to Reports.')
      } catch (e) {
        return fail(e)
      }
    },
  )

  registerNoteTools(server, managerId)
  return server
}

/**
 * The owner's notes that are shared with the agents (Reports → Notes, "Share with agents"): every agent can list, read,
 * write, change and delete them. Notes the owner didn't share don't exist here.
 */
function registerNoteTools(server: McpServer, agentId: string) {
  const wrap = <A,>(fn: (a: A) => Text | Promise<Text>) => async (a: A) => {
    try {
      return await fn(a)
    } catch (e) {
      return fail(e)
    }
  }
  server.registerTool(
    'list_notes',
    {
      description:
        "The owner's notes shared with the agents (pinned first, then the owner's order): id, title, folder, tags, who wrote it, " +
        'a preview. Ideas, decisions, plans and references the owner keeps for the team. read_note for the whole text.',
      inputSchema: {
        query: z.string().optional().describe('words to find in the title or text'),
        folder: z.string().optional().describe('only notes about this folder (absolute path; folders inside it too)'),
      },
    },
    wrap(({ query, folder }: { query?: string; folder?: string }) => {
      const notes = agentNotes({ query, folder: cleanFolder(folder) })
      if (!notes.length) return text(query || folder ? 'No shared note matches.' : 'The owner has not shared any notes yet.')
      return json(notes.map((n) => noteForAgent(n, false)))
    }),
  )
  server.registerTool(
    'read_note',
    { description: 'One shared note, its whole text as Markdown.', inputSchema: { id: z.string().describe('the note id (list_notes)') } },
    wrap(({ id }: { id: string }) => json(noteForAgent(agentReadNote(id), true))),
  )
  server.registerTool(
    'write_note',
    {
      description:
        "Add a note to the owner's Notes (shared, so the team can read it too). Markdown: # headings, - lists, " +
        '- [ ] checklists, **bold**, *italic*, `code`, [links](https://…), > quotes, ``` code blocks.',
      inputSchema: {
        title: z.string().describe('a short title'),
        markdown: z.string().describe('the text'),
        folder: z.string().optional().describe('absolute path of the folder it is about'),
        tags: z.array(z.string()).optional().describe('existing tag names'),
      },
    },
    wrap(({ title, markdown, folder, tags }: { title: string; markdown: string; folder?: string; tags?: string[] }) => {
      const n = agentWriteNote(agentId, { title, markdown, folder, tags: tagIdsByName(tags) })
      return text(`Added the note "${n.title}" (${n.id}).`)
    }),
  )
  server.registerTool(
    'edit_note',
    {
      description:
        'Change a shared note: its title, its whole text (markdown: replaces it, losing colours and other formatting the ' +
        'owner added), or add to its end (append: keeps everything before). Also its folder or tags.',
      inputSchema: {
        id: z.string().describe('the note id'),
        title: z.string().optional(),
        markdown: z.string().optional().describe('the new whole text'),
        append: z.string().optional().describe('Markdown added at the end'),
        folder: z.string().optional().describe('absolute path of the folder it is about; empty string: none'),
        tags: z.array(z.string()).optional().describe('the tag names it should have (empty: none)'),
      },
    },
    wrap(({ id, title, markdown, append, folder, tags }: { id: string; title?: string; markdown?: string; append?: string; folder?: string; tags?: string[] }) => {
      const n = agentEditNote(agentId, id, { title, markdown, append, folder: folder === undefined ? undefined : folder.trim() || null, tags: tags === undefined ? undefined : (tagIdsByName(tags) ?? []) })
      return text(`Updated the note "${n.title}".`)
    }),
  )
  server.registerTool(
    'delete_note',
    { description: 'Delete a shared note for good. Only when the owner asked for it, or the note is clearly yours and obsolete.', inputSchema: { id: z.string() } },
    wrap(({ id }: { id: string }) => text(`Deleted the note "${agentDeleteNote(id).title || 'Untitled'}".`)),
  )
}

/** Every other agent: the owner's shared notes only. */
function buildWorkerServer(agentId: string) {
  const me = agentsRepo.get(agentId)
  const server = new McpServer(
    { name: 'after-office', version: '1.0.0' },
    {
      instructions:
        `Tools of the After Office dashboard for ${me?.name ?? 'an agent'}: the notes the owner shares with the team ` +
        '(ideas, decisions, plans, references). Check them when a task touches what they cover; add or update one when ' +
        'the owner asks, or when what you learned is worth keeping for the team.',
    },
  )
  registerNoteTools(server, agentId)
  return server
}

/** POST /mcp (and GET/DELETE, which stateless mode answers itself): the manager's tools, or the others' notes tools. */
export async function handleMcp(c: Context) {
  const id = c.req.header('x-ao-agent')
  const row = id ? agentsRepo.get(id) : null
  if (!row) return c.json({ error: 'Unknown agent' }, 401)
  // which of its sessions is calling (its main one, or a side one the owner opened): work started from a side session
  // reports back there
  const server = row.kind === 'manager' ? buildServer(row.id, sessionKeyOf(c.req.header('x-ao-session'))) : buildWorkerServer(row.id)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(c.req.raw)
  } finally {
    void server.close()
  }
}
