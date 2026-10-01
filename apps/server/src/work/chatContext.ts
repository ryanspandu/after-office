import type { Attachment, WorkReport } from '@after-office/shared'
import { agentsRepo, projectsRepo, reportsRepo } from '../db'
import { AgentError } from '../agents/errors'
import { cleanTagIds, listTags } from './tags'

// The chat's optional project and tags (the owner picks them above the message box). The message gets a short block
// saying so. The manager uses them for the work it hands out (delegate_task / notify_user). Any other agent gets the
// project's folder and brief, and its answer to that message is kept in Reports under that project and those tags
// (a chat answer is otherwise not a report).

/** Starts the block added after the owner's words (the dashboard shows it as chips, not text). */
export const CONTEXT_HEADER = '[After Office context]'

export interface ChatContext {
  projectId?: string
  tags?: string[]
}

/** What the owner picked, checked: an existing project, existing tags (unknown ones are dropped). */
export function cleanChatContext(projectId: unknown, tags: unknown): ChatContext {
  const project = typeof projectId === 'string' && projectId ? projectsRepo.get(projectId) : null
  if (typeof projectId === 'string' && projectId && !project) throw new AgentError('No such project', 404)
  const tagIds = cleanTagIds(Array.isArray(tags) ? tags : undefined)
  return { ...(project ? { projectId: project.id } : {}), ...(tagIds ? { tags: tagIds } : {}) }
}

/** The block for this agent (null without a project or tags). */
export function contextBlock(agentId: string, ctx: ChatContext) {
  if (!ctx.projectId && !ctx.tags?.length) return null
  const project = ctx.projectId ? projectsRepo.get(ctx.projectId) : null
  const names = (ctx.tags ?? []).map((id) => listTags().find((t) => t.id === id)?.name).filter(Boolean) as string[]
  const manager = agentsRepo.get(agentId)?.kind === 'manager'
  const lines = [CONTEXT_HEADER]
  if (manager) {
    if (project) lines.push(`Project: ${project.name} (id ${project.id})`)
    if (names.length) lines.push(`Tags: ${names.join(', ')}`)
    lines.push(
      `Use ${project && names.length ? 'this project and these tags' : project ? 'this project' : 'these tags'} for the work this message leads to: ` +
        `${project ? '`project`' : ''}${project && names.length ? ' and ' : ''}${names.length ? '`tags`' : ''} in delegate_task / update_task` +
        `${names.length ? ', and `tags` in notify_user' : ''}.`,
    )
  } else {
    if (project) {
      lines.push(`Project: ${project.name}`)
      if (project.folder) lines.push(`Folder: ${project.folder} (work there)`)
      if (project.brief?.trim()) lines.push(`Project context: ${project.brief.trim().slice(0, 2000)}`)
    }
    if (names.length) lines.push(`Tags: ${names.join(', ')}`)
    lines.push("Your answer to this message is kept in the owner's Reports: make it complete enough to read on its own.")
  }
  return lines.join('\n')
}

/** The owner's words + the block (attachments, if any, are listed after both). */
export const withContext = (text: string, block: string | null) => (block ? [text.trim(), block].filter(Boolean).join('\n\n') : text)

const TITLE_MAX = 80
/** A chat answer kept as a report: titled with the start of what the owner asked. */
export function chatReport(agentId: string, asked: string, ctx: ChatContext, answer: string | undefined, ok: boolean, startedAt: number, files: Attachment[]): WorkReport {
  const line = asked.split('\n').find((l) => l.trim())?.trim() ?? 'Chat'
  return {
    id: crypto.randomUUID(),
    kind: 'chat',
    refId: agentId,
    title: line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line,
    agentId,
    text: answer?.trim() || (ok ? 'Finished without a final message.' : 'The turn failed.'),
    ok,
    startedAt,
    finishedAt: Date.now(),
    read: false,
    ...(files.length ? { files } : {}),
    ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
    ...(ctx.tags?.length ? { tags: ctx.tags } : {}),
  }
}

export const putChatReport = (r: WorkReport) => {
  reportsRepo.put(r)
  reportsRepo.prune()
}
