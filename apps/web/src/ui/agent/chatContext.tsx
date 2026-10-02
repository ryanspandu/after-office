import { useState } from 'react'
import { LuFolder, LuTag, LuX } from 'react-icons/lu'
import { useDashboard } from '../../state/dashboard'
import { ProjectFolderPicker } from '../ProjectFolderPicker'
import { TagPicker } from '../tags'

// The chat's optional folder and tags (above the message box). They stay picked for that chat (one agent's session, in
// this browser) until changed or cleared: each session keeps its own. The server adds them to the message as a block (apps/server/src/work/chatContext.ts): the manager uses them
// for the work it hands out; any other agent works in that folder, and its answer is kept in Reports with them.

export interface ChatContext {
  folder: string
  tags: string[]
}
const EMPTY: ChatContext = { folder: '', tags: [] }
/** Per chat: the main session keeps the key it always had, a side session (s2, s3…) one of its own. */
const key = (chat: string) => `ao-chat-ctx:${chat}`
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p

function load(chat: string): ChatContext {
  try {
    const v = JSON.parse(localStorage.getItem(key(chat)) ?? 'null')
    // (a saved project from before folders: dropped)
    return v && Array.isArray(v.tags) ? { folder: typeof v.folder === 'string' ? v.folder : '', tags: v.tags.filter((t: unknown) => typeof t === 'string') } : EMPTY
  } catch {
    return EMPTY
  }
}

/** This chat's picks (an agent's main session, or one of its side sessions); tags that no longer exist are left out. */
export function useChatContext(agentId: string, session = '') {
  const chat = session ? `${agentId}:${session}` : agentId
  const [state, setState] = useState(() => ({ chat, ctx: load(chat) }))
  // the same view showing another chat (another agent, another session): that chat's picks
  const ctx = state.chat === chat ? state.ctx : load(chat)
  const setCtx = (next: ChatContext) => setState({ chat, ctx: next })
  const tags = useDashboard((s) => s.tags)
  const value: ChatContext = { folder: ctx.folder, tags: ctx.tags.filter((id) => tags.some((t) => t.id === id)) }
  const set = (next: ChatContext) => {
    setCtx(next)
    try {
      if (next.folder || next.tags.length) localStorage.setItem(key(chat), JSON.stringify(next))
      else localStorage.removeItem(key(chat))
    } catch {
      // private mode / storage off: it just doesn't stay
    }
  }
  return { value, set, active: !!value.folder || value.tags.length > 0 }
}

/** The row above the message box: a folder and tags, both optional. */
export function ChatContextBar({ value, onChange, manager }: { value: ChatContext; onChange: (v: ChatContext) => void; manager: boolean }) {
  const any = !!value.folder || value.tags.length > 0
  return (
    <div className="chat-ctx">
      <span className="chat-ctx__field">
        <LuFolder className="chat-ctx__icon" />
        <FolderButton value={value.folder} onChange={(folder) => onChange({ ...value, folder })} />
      </span>
      <span className="chat-ctx__field chat-ctx__field--tags">
        <LuTag className="chat-ctx__icon" />
        <TagPicker size="sm" menuPlacement="top" value={value.tags} onChange={(tags) => onChange({ ...value, tags })} />
      </span>
      <span className="chat-ctx__hint muted">
        {manager ? 'Used for the tasks and reports this leads to.' : any ? 'The answer goes to Reports with these.' : 'Optional: the answer then goes to Reports.'}
      </span>
      {any && (
        <button className="chat-ctx__clear" aria-label="Clear the folder and tags" data-tip="Stop sending a folder and tags" onClick={() => onChange(EMPTY)}>
          <LuX /> Clear
        </button>
      )}
    </div>
  )
}

const HEADER = '[After Office context]'

/** A sent message → what the owner wrote, and the folder / tags it was sent with (from the server's block). */
export function splitContext(text: string): { text: string; folder?: string; tags: string[] } {
  const at = text.lastIndexOf(`\n\n${HEADER}`)
  const start = text.startsWith(HEADER) ? 0 : at
  if (start === -1) return { text, tags: [] }
  const lines = text.slice(start).trim().split('\n')
  // older messages were sent with a project: shown the same way
  const folder =
    lines.find((l) => l.startsWith('Folder: '))?.slice('Folder: '.length).replace(/ \(work there\)$/, '') ??
    lines.find((l) => l.startsWith('Project: '))?.slice('Project: '.length).replace(/ \(id [^)]+\)$/, '')
  const tags = lines.find((l) => l.startsWith('Tags: '))?.slice('Tags: '.length).split(', ').filter(Boolean) ?? []
  return { text: text.slice(0, start).trim(), ...(folder ? { folder } : {}), tags }
}

/** Under the owner's message: the folder and tags it was sent with. */
export function ContextChips({ folder, tags }: { folder?: string; tags: string[] }) {
  if (!folder && !tags.length) return null
  return (
    <div className="chat-ctx-chips">
      {folder && (
        <span className="chat-ctx-chip" data-tip={folder}>
          <LuFolder /> {base(folder)}
        </span>
      )}
      {tags.map((t) => (
        <span key={t} className="chat-ctx-chip">
          <LuTag /> {t}
        </span>
      ))}
    </div>
  )
}

/** The chat's folder: picked with the folder picker, however deep. */
export function FolderButton({ value, onChange, tip = 'Choose the folder this chat is about' }: { value: string; onChange: (folder: string) => void; tip?: string }) {
  const [browsing, setBrowsing] = useState(false)
  return (
    <>
      {browsing && <ProjectFolderPicker onPick={(folder) => onChange(folder)} onClose={() => setBrowsing(false)} />}
      <span className="chat-ctx__project">
        <button type="button" className="chat-ctx__pick" onClick={() => setBrowsing(true)} data-tip={value || tip}>
          {value ? <span className="truncate">{base(value)}</span> : <span className="muted">Choose a folder…</span>}
        </button>
        {value && (
          <button type="button" className="chat-ctx__unpick" aria-label="No folder" onClick={() => onChange('')}>
            <LuX />
          </button>
        )}
      </span>
    </>
  )
}
