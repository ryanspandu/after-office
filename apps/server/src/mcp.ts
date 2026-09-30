import type { Context } from 'hono'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { DEFAULT_MODEL, divisionOf, MODEL_CHOICES, RULE_PACKS, type OfficeTask, type RulePackId } from '@after-office/shared'
import { agentsRepo, commentsRepo, connectorsOf, projectsRepo, queueRepo, reportsRepo, tasksRepo, type AgentRow } from './db'
import { knownConnectors, listConnectors } from './agents/connectors'
import { diffSince } from './work/git'
import { AgentError } from './agents/manager'
import { requestHire } from './work/hires'
import { bossMode, countBoss } from './work/settings'
import { noteManagerMessage } from './work/activity'
import { runtimeOf } from './agents/registry'
import { isReadingAgentOutput, managerReviseTask, MAX_MANAGER_REVISIONS, addComment, assignTask, checkFor, taskFolder, deliver, delegateTask, expectReply, managerDeleteTask, managerUpdateTask, notifyUser, quotaPause, waitingOn } from './work/work'
import { listTags, tagIdsByName, tagNames } from './work/tags'
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

/** A project by id or name (case-insensitive). */
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

function resolveProject(ref: string) {
  const key = ref.trim().toLowerCase()
  const p = projectsRepo.get(ref.trim()) ?? projectsRepo.all().find((x) => x.name.toLowerCase() === key)
  if (!p) throw new AgentError(`No project "${ref}"; see list_projects`, 404)
  return p
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
    agent: t.agentId ? (agentsRepo.get(t.agentId)?.name ?? t.agentId) : null,
    agentId: t.agentId,
    status: t.status,
    priority: t.priority,
    deadline: iso(t.deadline),
    delegatedByYou: !!t.delegatedBy,
    project: t.projectId ? (projectsRepo.get(t.projectId)?.name ?? null) : null,
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

function buildServer(managerId: string) {
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
        project: z.string().optional().describe('project id or name from list_projects; its brief is added to the prompt and its quality check runs when done'),
        after: z
          .array(z.string())
          .max(20)
          .optional()
          .describe('task ids this one waits for; it starts on its own once they are finished (use it to chain steps, e.g. build → test)'),
        tags: z.array(z.string().max(40)).max(10).optional().describe('tag names the owner made (see list_tags), e.g. ["SEO"]; only existing tags'),
      },
    },
    async ({ agent, title, description, priority, deadlineHours, mode, after, project, tags }) => {
      try {
        const target = resolveAgent(agent, managerId)
        const out = await delegateTask(managerId, {
          agent: target.id,
          after,
          projectId: project ? resolveProject(project).id : null,
          tags: tagIdsByName(tags),
          title,
          description,
          priority,
          mode,
          deadline: deadlineHours ? Date.now() + deadlineHours * 3_600_000 : undefined,
        })
        const delivery =
          out.result === 'sent'
            ? 'sent now'
            : out.result === 'queued'
              ? 'queued until the agent is free'
              : out.result === 'waiting'
                ? `waits for: ${out.waitingFor.join(', ')}; starts on its own when they are finished`
                : out.result === 'approval'
                  ? "waiting for the owner's approval in the dashboard; if they reject it you get a message"
                  : `on hold: ${out.paused}; starts on its own when usage drops`
        const boss = bossMode()
        return json({ taskId: out.task.id, agent: target.name, division: divisionOf(target.role), delivery, ...(boss ? { bossMode: `on until ${new Date(boss.until).toISOString()}: started without approval` } : {}) })
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
        if (target.id !== managerId) expectReply(target.id, managerId)
        return text(result === 'sent' ? `Sent to ${target.name}.` : `${target.name} is busy; queued.`)
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
      description: 'Recent reports (task results and daily-job runs), newest first.',
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
        .map((r) => ({ kind: r.kind, title: r.title, agent: agentsRepo.get(r.agentId)?.name, ok: r.ok, finishedAt: iso(r.finishedAt), tags: tagNames(r.tags), text: r.text }))
      return reports.length ? json(reports) : text('No reports in that window.')
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

  server.registerTool(
    'list_projects',
    { description: 'Projects in the dashboard: id, name, brief (goal / repo / conventions) and quality check command.' },
    async () => {
      const list = projectsRepo.all().map((p) => ({ id: p.id, name: p.name, folder: p.folder ?? null, brief: p.brief ?? null, check: p.check ?? null }))
      return list.length ? json(list) : text('No projects yet.')
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
          .optional()
          .describe("its character in the office. Set it from what the owner said (e.g. \"a female secretary\", \"cewek\", \"she\"); don't guess from the name alone. Unset: the dashboard picks one, and the owner can change it."),
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
        'Edit a task: title, description, priority, deadline, agent, project, what it waits for, quality check, or status ' +
        '(todo / review / done; "done" accepts it). Tasks in progress can only get text/priority/deadline changes. Changes show on its timeline.',
      inputSchema: {
        task: z.string().describe('task id'),
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(20_000).optional(),
        priority: z.enum(['low', 'medium', 'high']).optional(),
        deadlineHours: z.number().positive().max(24 * 60).optional().describe('new deadline, hours from now'),
        status: z.enum(['todo', 'review', 'done']).optional(),
        agent: z.string().optional().describe('agent id or name; "none" to unassign'),
        project: z.string().optional().describe('project id or name; "none" to clear'),
        after: z.array(z.string()).max(20).optional().describe('task ids it waits for (replaces the list; [] = none)'),
        tags: z.array(z.string().max(40)).max(10).optional().describe('tag names (replaces the list; [] = none); ' + 'tag names the owner made (see list_tags), e.g. ["SEO"]; only existing tags'),
        check: z
          .string()
          .max(1000)
          .optional()
          .describe('quality check command for this task (runs in the agent\'s folder when it finishes); a new command waits for the owner\'s approval; "" clears it'),
      },
    },
    async ({ task, title, description, priority, deadlineHours, status, agent, project, after, check, tags }) => {
      try {
        const none = (v?: string) => v !== undefined && /^(none|null|)$/i.test(v.trim())
        const t = await managerUpdateTask(managerId, task, {
          title,
          description,
          priority,
          deadline: deadlineHours ? Date.now() + deadlineHours * 3_600_000 : undefined,
          status,
          agentId: agent === undefined ? undefined : none(agent) ? null : resolveAgent(agent, managerId).id,
          projectId: project === undefined ? undefined : none(project) ? null : resolveProject(project).id,
          blockedBy: after,
          check,
          tags: tags === undefined ? undefined : (tagIdsByName(tags) ?? []),
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
        return text(result === 'sent' ? 'Sent back for another round.' : 'Queued: the agent is busy; it gets the feedback next.')
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
        'Put a note in the dashboard’s Reports (unread badge, and a push notification to their phone if set up), for things the owner should see even if they are not reading this chat. When it is about a project (its tasks, its results), give `project`: the note then also shows in that project\'s reports.',
      inputSchema: {
        title: z.string().min(1).max(200),
        text: z.string().min(1).max(20_000),
        project: z.string().max(100).optional().describe('project id or name (see list_projects) the note is about'),
        tags: z.array(z.string().max(40)).max(10).optional().describe("tag names the owner made (see list_tags), e.g. [\"SEO\"]; only existing tags"),
      },
    },
    async ({ title, text: body, project, tags }) => {
      try {
        const p = project?.trim() ? resolveProject(project) : null
        notifyUser(managerId, title, body, p?.id ?? null, tagIdsByName(tags))
        return text(p ? `Posted to Reports, under project "${p.name}".` : 'Posted to Reports.')
      } catch (e) {
        return fail(e)
      }
    },
  )

  return server
}

/** POST /mcp (and GET/DELETE, which stateless mode answers itself). Only the manager agent may connect. */
export async function handleMcp(c: Context) {
  const id = c.req.header('x-ao-agent')
  const row = id ? agentsRepo.get(id) : null
  if (!row) return c.json({ error: 'Unknown agent' }, 401)
  if (row.kind !== 'manager') return c.json({ error: 'Only the manager agent can use these tools' }, 403)
  const server = buildServer(row.id)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(c.req.raw)
  } finally {
    void server.close()
  }
}
