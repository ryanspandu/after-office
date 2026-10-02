import type { Attachment, WorkReport } from '@after-office/shared'
import { agentsRepo, reportsRepo } from '../db'
import { cleanTagIds, listTags } from './tags'
import { cleanFolder } from './folders'

// The chat's optional folder and tags (the owner picks them above the message box). The message gets a short block
// saying so. The manager uses them for the work it hands out (delegate_task / notify_user). Any other agent works in
// that folder, and its answer to that message is kept in Reports with that folder and those tags (a chat answer is
// otherwise not a report).

/** Starts the block added after the owner's words (the dashboard shows it as chips, not text). */
export const CONTEXT_HEADER = '[After Office context]'

export interface ChatContext {
  folder?: string
  tags?: string[]
}

/** What the owner picked, checked: a folder agents may work in, existing tags (unknown ones are dropped). */
export function cleanChatContext(folder: unknown, tags: unknown): ChatContext {
  const path = cleanFolder(folder)
  const tagIds = cleanTagIds(Array.isArray(tags) ? tags : undefined)
  return { ...(path ? { folder: path } : {}), ...(tagIds ? { tags: tagIds } : {}) }
}

/** The block for this agent (null without a folder or tags). */
export function contextBlock(agentId: string, ctx: ChatContext) {
  if (!ctx.folder && !ctx.tags?.length) return null
  const names = (ctx.tags ?? []).map((id) => listTags().find((t) => t.id === id)?.name).filter(Boolean) as string[]
  const manager = agentsRepo.get(agentId)?.kind === 'manager'
  const lines = [CONTEXT_HEADER]
  if (manager) {
    if (ctx.folder) lines.push(`Folder: ${ctx.folder}`)
    if (names.length) lines.push(`Tags: ${names.join(', ')}`)
    lines.push(
      `Use ${ctx.folder && names.length ? 'this folder and these tags' : ctx.folder ? 'this folder' : 'these tags'} for the work this message leads to: ` +
        `${ctx.folder ? '`folder`' : ''}${ctx.folder && names.length ? ' and ' : ''}${names.length ? '`tags`' : ''} in delegate_task / update_task` +
        `${names.length ? ', and `tags` in notify_user' : ''}.`,
    )
  } else {
    if (ctx.folder) lines.push(`Folder: ${ctx.folder} (work there)`)
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
    ...(ctx.folder ? { folder: ctx.folder } : {}),
    ...(ctx.tags?.length ? { tags: ctx.tags } : {}),
  }
}

export const putChatReport = (r: WorkReport) => {
  reportsRepo.put(r)
  reportsRepo.prune()
}
