import { useState } from 'react'
import { LuFolder, LuTag, LuX } from 'react-icons/lu'
import { useDashboard } from '../../state/dashboard'
import { ProjectFolderPicker } from '../ProjectFolderPicker'
import { TagPicker } from '../tags'

// The chat's optional project and tags (above the message box). They stay picked for that agent (this browser) until
// cleared. The server adds them to the message as a block (apps/server/src/work/chatContext.ts): the manager uses them
// for the work it hands out; any other agent's answer is kept in Reports under them.

export interface ChatContext {
  projectId: string
  tags: string[]
}
const EMPTY: ChatContext = { projectId: '', tags: [] }
const key = (agentId: string) => `ao-chat-ctx:${agentId}`

function load(agentId: string): ChatContext {
  try {
    const v = JSON.parse(localStorage.getItem(key(agentId)) ?? 'null')
    return v && typeof v.projectId === 'string' && Array.isArray(v.tags) ? { projectId: v.projectId, tags: v.tags.filter((t: unknown) => typeof t === 'string') } : EMPTY
  } catch {
    return EMPTY
  }
}

/** The agent's picks; ones that no longer exist (a deleted project or tag) are left out. */
export function useChatContext(agentId: string) {
  const [state, setState] = useState(() => ({ agentId, ctx: load(agentId) }))
  // the same chat showing another agent (the drawer switched): that agent's picks
  const ctx = state.agentId === agentId ? state.ctx : load(agentId)
  const setCtx = (next: ChatContext) => setState({ agentId, ctx: next })
  const projects = useDashboard((s) => s.projects)
  const tags = useDashboard((s) => s.tags)
  const value: ChatContext = {
    projectId: projects.some((p) => p.id === ctx.projectId) ? ctx.projectId : '',
    tags: ctx.tags.filter((id) => tags.some((t) => t.id === id)),
  }
  const set = (next: ChatContext) => {
    setCtx(next)
    try {
      if (next.projectId || next.tags.length) localStorage.setItem(key(agentId), JSON.stringify(next))
      else localStorage.removeItem(key(agentId))
    } catch {
      // private mode / storage off: it just doesn't stay
    }
  }
  return { value, set, active: !!value.projectId || value.tags.length > 0 }
}

/** The row above the message box: a project and tags, both optional. */
export function ChatContextBar({ value, onChange, manager }: { value: ChatContext; onChange: (v: ChatContext) => void; manager: boolean }) {
  const any = !!value.projectId || value.tags.length > 0
  return (
    <div className="chat-ctx">
      <span className="chat-ctx__field">
        <LuFolder className="chat-ctx__icon" />
        <ProjectFolderButton value={value.projectId} onChange={(projectId) => onChange({ ...value, projectId })} />
      </span>
      <span className="chat-ctx__field chat-ctx__field--tags">
        <LuTag className="chat-ctx__icon" />
        <TagPicker size="sm" menuPlacement="top" value={value.tags} onChange={(tags) => onChange({ ...value, tags })} />
      </span>
      <span className="chat-ctx__hint muted">
        {manager ? 'Used for the tasks and reports this leads to.' : any ? 'The answer goes to Reports under these.' : 'Optional: the answer then goes to Reports.'}
      </span>
      {any && (
        <button className="chat-ctx__clear" aria-label="Clear the project and tags" data-tip="Stop sending a project and tags" onClick={() => onChange(EMPTY)}>
          <LuX /> Clear
        </button>
      )}
    </div>
  )
}

const HEADER = '[After Office context]'

/** A sent message → what the owner wrote, and the project / tags it was sent with (from the server's block). */
export function splitContext(text: string): { text: string; project?: string; tags: string[] } {
  const at = text.lastIndexOf(`\n\n${HEADER}`)
  const start = text.startsWith(HEADER) ? 0 : at
  if (start === -1) return { text, tags: [] }
  const lines = text.slice(start).trim().split('\n')
  const project = lines.find((l) => l.startsWith('Project: '))?.slice('Project: '.length).replace(/ \(id [^)]+\)$/, '')
  const tags = lines.find((l) => l.startsWith('Tags: '))?.slice('Tags: '.length).split(', ').filter(Boolean) ?? []
  return { text: text.slice(0, start).trim(), ...(project ? { project } : {}), tags }
}

/** Under the owner's message: the project and tags it was sent with. */
export function ContextChips({ project, tags }: { project?: string; tags: string[] }) {
  if (!project && !tags.length) return null
  return (
    <div className="chat-ctx-chips">
      {project && (
        <span className="chat-ctx-chip">
          <LuFolder /> {project}
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

/**
 * The chat's project: picked as a folder (the folder picker, however deep). The project linked to that folder, or a new
 * one named after it.
 */
export function ProjectFolderButton({ value, onChange, tip = 'Choose the folder this chat is about' }: { value: string; onChange: (projectId: string) => void; tip?: string }) {
  const projects = useDashboard((s) => s.projects)
  const addProject = useDashboard((s) => s.addProject)
  const [browsing, setBrowsing] = useState(false)
  const project = projects.find((p) => p.id === value)
  const pick = (folder: string) => {
    const name = folder.split('/').filter(Boolean).pop() ?? folder
    onChange(projects.find((p) => p.folder === folder)?.id ?? addProject(name, { folder }))
  }
  return (
    <>
      {browsing && <ProjectFolderPicker onPick={pick} onClose={() => setBrowsing(false)} />}
      <span className="chat-ctx__project">
        <button type="button" className="chat-ctx__pick" onClick={() => setBrowsing(true)} data-tip={project?.folder ?? tip}>
          {project ? (
            <>
              <span className="chip__dot" style={{ background: project.color }} />
              <span className="truncate">{project.name}</span>
            </>
          ) : (
            <span className="muted">Choose a folder…</span>
          )}
        </button>
        {project && (
          <button type="button" className="chat-ctx__unpick" aria-label="No project" onClick={() => onChange('')}>
            <LuX />
          </button>
        )}
      </span>
    </>
  )
}
