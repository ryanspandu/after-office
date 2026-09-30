import { useEffect, useMemo, useState } from 'react'
import { matchesSearch } from './SearchBox'
import { LuCopy, LuFolder, LuFolderGit2, LuFolderPlus, LuGitBranch, LuGitCommitHorizontal, LuPlus, LuRefreshCw, LuSettings2, LuTrash2, LuEye, LuEyeOff, LuChevronRight } from 'react-icons/lu'
import { DeleteProject } from './DeleteProject'
import { ProjectReports } from './Reports'
import { confirm } from './Confirm'
import { api } from '../state/auth'
import { FileBrowser } from './FileBrowser'
import { openUrl } from '../state/url'
import type { GitCommit, Workspace, WorkspaceFolder } from '@after-office/shared'
import { useNow } from '../state/clock'
import { useDashboard } from '../state/dashboard'
import { liveApi } from '../state/live'
import { useWorkspaces } from '../state/workspaces'
import { useOffice, type OfficeAgent, avatarStyle } from '../state/store'
import { ago } from './FollowUps'
import { Modal } from './Modal'
import { STATUS_BY_ID } from './taskMeta'
import { Previews } from './Previews'

// Projects tab: what the agents are working on, straight from their folders. A folder that is a git repo is one
// project; any other agent folder is a home with one project per subfolder. The office's own projects folder
// (~/after-office/project, where new projects get a folder) is listed too. Folders are only read here; projects can
// be set up, renamed and deleted (with their folder, if the office made it).

/** The agents' folders, loaded on mount and refreshed quietly every minute while the page is visible. */
function useWorkspaceData() {
  const live = useOffice((s) => s.source === 'live')
  const { data, error, loading, load } = useWorkspaces()
  useEffect(() => {
    if (!live) return
    void load()
    const id = setInterval(() => document.visibilityState === 'visible' && void load(), 60_000)
    return () => clearInterval(id)
  }, [live, load])
  return { live, data, error, loading, refresh: () => load(true) }
}

export type Open = { folder: WorkspaceFolder; agentIds: string[]; orphan?: boolean }

export function ProjectsTab({ q = '' }: { q?: string }) {
  const ws = useWorkspaceData()
  const agents = useOffice((s) => s.agents)
  const now = useNow(60_000).getTime()
  // a folder's details and the new-project form open in the address bar (ui/UrlModals.tsx)
  const setOpen = (o: Open) => openUrl({ folder: o.folder.path })
  // folders whose agent was removed: shown by default, hideable (remembered in this browser)
  const [showOrphans, setShowOrphans] = useState(() => {
    try {
      return localStorage.getItem('ao-show-orphan-folders') !== 'off'
    } catch {
      return true
    }
  })
  // agent folders with projects start folded; the ones opened are remembered in this browser (a search opens them all)
  const [unfolded, setUnfolded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('ao-open-folders') ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const toggleFold = (path: string) =>
    setUnfolded((cur) => {
      const next = new Set(cur)
      if (!next.delete(path)) next.add(path)
      try {
        localStorage.setItem('ao-open-folders', JSON.stringify([...next]))
      } catch {
        /* this visit only */
      }
      return next
    })
  const toggleOrphans = () =>
    setShowOrphans((v) => {
      try {
        localStorage.setItem('ao-show-orphan-folders', v ? 'off' : 'on')
      } catch {
        /* this visit only */
      }
      return !v
    })

  if (!ws.live) return <div className="empty">Projects come from your agents' folders in live mode.</div>
  if (ws.error) return <div className="row__error">{ws.error}</div>
  if (!ws.data) return <div className="empty">Reading the agents' folders…</div>
  if (!ws.data.length) return <div className="empty">No agents yet. Their folders show up here.</div>

  const orphans = ws.data.filter((w) => w.orphan).length
  // a search keeps the agent folders that match, or that hold a project that does (only those projects then)
  const shown = (showOrphans ? ws.data : ws.data.filter((w) => !w.orphan))
    .map((w) => {
      if (!q.trim()) return w
      const people = w.agentIds.map((id) => agents.find((a) => a.id === id)?.name).join(' ')
      if (matchesSearch(q, w.name, w.path, people)) return w
      const projects = w.projects.filter((p) => matchesSearch(q, p.name, p.path))
      return projects.length ? { ...w, projects } : null
    })
    .filter((w): w is NonNullable<typeof w> => !!w)
  const count = shown.reduce((n, w) => n + (w.isProject ? 1 : w.projects.length), 0)
  const agentFolders = shown.filter((w) => !w.shared).length
  const summary = `${count} project${count === 1 ? '' : 's'} in ${agentFolders} agent folder${agentFolders === 1 ? '' : 's'}${
    !showOrphans && orphans ? ` (${orphans} without an agent hidden)` : ''
  }`
  return (
    <>
      <Previews />
      <div className="ws-bar">
        {/* may be cut short in a narrow column: the whole line in a tooltip */}
        <span className="muted" data-tip={summary}>
          {summary}
        </span>
        <span className="grow" />
        <button className="icon-btn small" data-tip="New project" aria-label="New project" onClick={() => openUrl({ newproject: '1' })}>
          <LuFolderPlus />
        </button>
        <button
          className="icon-btn small"
          disabled={!orphans}
          onClick={toggleOrphans}
          data-tip={!orphans ? 'No folders without an agent' : showOrphans ? `Hide ${orphans} folder${orphans === 1 ? '' : 's'} with no agent` : `Show ${orphans} folder${orphans === 1 ? '' : 's'} with no agent`}
          aria-label={showOrphans ? 'Hide folders with no agent' : 'Show folders with no agent'}
        >
          {showOrphans ? <LuEyeOff /> : <LuEye />}
        </button>
        <ProjectsRefresh ws={ws} />
      </div>
      <div className="ws-list">
        {!shown.length && <div className="empty">No projects match.</div>}
        {shown.map((w) => {
          const people = w.agentIds.map((id) => agents.find((a) => a.id === id)).filter(Boolean) as OfficeAgent[]
          const foldable = !w.isProject && w.projects.length > 0
          const open = !foldable || !!q.trim() || unfolded.has(w.path)
          return (
            <section key={w.path} className={`ws${w.orphan ? ' ws--orphan' : ''}`}>
              <div className="ws__top">
              {foldable ? (
                <button
                  className="ws__fold"
                  aria-expanded={open}
                  aria-label={open ? `Fold ${w.name}` : `Show the projects in ${w.name}`}
                  data-tip={open ? 'Fold' : `${w.projects.length} project${w.projects.length === 1 ? '' : 's'}`}
                  onClick={() => toggleFold(w.path)}
                >
                  <LuChevronRight />
                </button>
              ) : (
                // nothing inside to show: a dot where the chevron would be
                <span className="ws__fold ws__fold--none" aria-hidden>
                  <i className="ws__dot" />
                </span>
              )}
              <button
                className="ws__head"
                onClick={() => setOpen({ folder: w, agentIds: w.agentIds, orphan: w.orphan })}
                data-tip={w.orphan ? `${w.path} · its agent was removed` : w.path}
              >
                {w.git ? <LuFolderGit2 className="ws__icon" /> : <LuFolder className="ws__icon" />}
                <span className="ws__name truncate">{w.shared ? 'Projects folder' : w.name}</span>
                {w.isProject && <LinkedTag projectId={w.projectId} />}
                {foldable && !open && <span className="ws__count muted">{w.projects.length}</span>}
                {w.orphan ? <span className="ws__tag ws__tag--orphan">no agent</span> : <Avatars agents={people} />}
              </button>
              </div>
              {w.isProject ? (
                <GitLine folder={w} now={now} block />
              ) : !open ? null : w.projects.length ? (
                <ul className="ws__projects">
                  {w.projects.map((p) => (
                    <li key={p.path}>
                      <button className="ws-row" onClick={() => setOpen({ folder: p, agentIds: w.agentIds })} data-tip={p.path}>
                        {p.git ? <LuFolderGit2 className="ws-row__icon" /> : <LuFolder className="ws-row__icon" />}
                        <span className="ws-row__body">
                          <span className="ws-row__name">
                            <span className="truncate">{p.name}</span>
                            <LinkedTag projectId={p.projectId} />
                          </span>
                          <GitLine folder={p} now={now} compact />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : w.shared ? (
                <div className="ws__empty muted">New projects get their folder here.</div>
              ) : null}
            </section>
          )
        })}
      </div>
    </>
  )
}

/** The dashboard project a folder is linked to (colour + name), or a hint that it can be set up. */
function LinkedTag({ projectId }: { projectId?: string | null }) {
  const project = useDashboard((s) => s.projects.find((p) => p.id === projectId))
  if (!project) return <span className="ws__tag">project</span>
  return (
    <span className="ws__tag ws__tag--linked" data-tip={`Project “${project.name}”${project.check ? ' · has a quality check' : ''}`}>
      <span className="chip__dot" style={{ background: project.color }} />
      {project.name}
    </span>
  )
}

function Avatars({ agents }: { agents: OfficeAgent[] }) {
  return (
    <span className="ws__agents">
      {agents.slice(0, 4).map((a) => (
        <span key={a.id} className="avatar avatar--xs" style={avatarStyle(a.look.shirt)} data-tip={a.name}>
          {a.name[0]}
        </span>
      ))}
      {agents.length > 4 && <span className="muted">+{agents.length - 4}</span>}
    </span>
  )
}

function GitLine({ folder: f, now, compact, block }: { folder: WorkspaceFolder; now: number; compact?: boolean; block?: boolean }) {
  if (!f.git)
    return <span className={`ws-meta muted${block ? ' ws-meta--block' : ''}`}>{f.updatedAt ? `updated ${ago(now - f.updatedAt)} · no git` : 'folder'}</span>
  const g = f.git
  return (
    <span className={`ws-meta${block ? ' ws-meta--block' : ''}`}>
      {g.branch && (
        <span className="ws-meta__branch">
          <LuGitBranch /> {g.branch}
        </span>
      )}
      {g.dirty > 0 && <span className="ws-meta__dirty" data-tip="Changed or new files, not committed">{g.dirty} changed</span>}
      {g.lastCommit ? (
        <span className="muted truncate" data-tip={g.lastCommit.subject}>
          {compact ? ago(now - g.lastCommit.at) : `${g.lastCommit.subject} · ${ago(now - g.lastCommit.at)}`}
        </span>
      ) : (
        <span className="muted">no commits yet</span>
      )}
    </span>
  )
}

export function ProjectFolderModal({ open: { folder: f, agentIds, orphan }, onClose }: { open: Open; onClose: () => void }) {
  const agents = useOffice((s) => s.agents)
  const tasks = useDashboard((s) => s.tasks)
  const addProject = useDashboard((s) => s.addProject)
  const updateProject = useDashboard((s) => s.updateProject)
  // the project linked to this folder: from the scan, or one set up here a moment ago
  const project = useDashboard((s) => s.projects.find((p) => p.id === f.projectId || (p.folder && p.folder === f.path)))
  const reload = useWorkspaces((s) => s.load)
  const ensureProject = () => {
    if (project) return project.id
    const id = addProject(f.name, { folder: f.path })
    // the scan links it on its next read
    setTimeout(() => void reload(true), 800)
    return id
  }
  const now = useNow(60_000).getTime()
  const [commits, setCommits] = useState<GitCommit[] | null>(null)
  const [copied, setCopied] = useState(false)
  const people = agentIds.map((id) => agents.find((a) => a.id === id)).filter(Boolean) as OfficeAgent[]
  // a folder whose agent was removed: it can go, with everything in it (after a clear warning)
  const removeFolder = async () => {
    const ok = await confirm({
      title: `Delete the folder “${f.name}”?`,
      message: (
        <>
          <code>{f.path.replace(/^\/(Users|home)\/[^/]+/, '~')}</code> and everything in it are deleted for good.{' '}
          <span className="danger-text">Back up or download what you still need first (Files above: tick and Download .zip).</span>
        </>
      ),
      confirmLabel: 'Delete folder',
    })
    if (!ok) return
    const r = await api(`/api/workspaces/folder?${new URLSearchParams({ path: f.path })}`, { method: 'DELETE' })
    if (!r.ok) return void useDashboard.setState({ syncError: (await r.json().catch(() => null))?.error ?? 'Could not delete the folder' })
    void reload(true)
    onClose()
  }
  // tasks of the agents working here that mention the folder, else all their open tasks
  const related = useMemo(() => {
    const mine = tasks.filter((t) => t.status !== 'done' && ((project && t.projectId === project.id) || (t.agentId && agentIds.includes(t.agentId))))
    const here = mine.filter(
      (t) => (project && t.projectId === project.id) || (t.description ?? '').includes(f.path) || t.title.toLowerCase().includes(f.name.toLowerCase()),
    )
    return (here.length ? here : mine).slice(0, 8)
  }, [tasks, agentIds, f.path, f.name, project])

  useEffect(() => {
    if (f.git) liveApi.commits(f.path).then(setCommits)
  }, [f.path, f.git])

  return (
    <Modal open onClose={onClose} title={f.name} description={f.git ? 'Git repository' : 'Folder'} width={620}>
      <div className="modal__body ws-detail">
        <div className="ws-detail__path">
          <code className="truncate">{f.path}</code>
          <button
            className="icon-btn small ghost"
            data-tip={copied ? 'Copied' : 'Copy path'}
            aria-label="Copy path"
            onClick={() => void navigator.clipboard?.writeText(f.path).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1200)))}
          >
            <LuCopy />
          </button>
        </div>

        <div className="field">
          <span className="field__label">Agents here</span>
          <div className="ws-detail__agents">
            {!people.length && <span className="muted">{orphan ? 'None: its agent was removed. The files are still here.' : 'None.'}</span>}
            {people.map((a) => (
              <span key={a.id} className="chip">
                <span className="chip__dot" style={{ background: a.look.shirt }} />
                {a.name}
                <span className="muted">· {a.status}</span>
              </span>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field__label">Files</span>
          <FileBrowser root={f.path} />
        </div>

        {f.git && (
          <div className="field">
            <span className="field__label">
              Git <GitLine folder={f} now={now} compact />
            </span>
            {!commits ? (
              <span className="muted">Loading…</span>
            ) : !commits.length ? (
              <span className="muted">No commits yet.</span>
            ) : (
              <ul className="ws-commits">
                {commits.map((c) => (
                  <li key={c.hash}>
                    <LuGitCommitHorizontal className="muted" />
                    <code>{c.hash}</code>
                    <span className="truncate">{c.subject}</span>
                    <span className="muted ws-commits__meta">
                      {c.author} · {ago(now - c.at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="field ws-project">
          <span className="field__label">Project settings</span>
          {project ? (
            <>
              <p className="field__hint">Its tasks work in this folder, get the brief below, and run the check when they finish.</p>
              <div className="ws-project__name">
                <label className="field grow">
                  <span className="field__label">Name</span>
                  <input value={project.name} maxLength={60} onChange={(e) => updateProject(project.id, { name: e.target.value })} />
                </label>
                <DeleteProject project={project} taskCount={tasks.filter((t) => t.projectId === project.id).length} onDeleted={onClose} />
              </div>
              <label className="field">
                <span className="field__label">Brief</span>
                <textarea
                  rows={3}
                  maxLength={5000}
                  value={project.brief ?? ''}
                  onChange={(e) => updateProject(project.id, { brief: e.target.value || undefined })}
                  placeholder="Goal, stack, conventions. Added to every task in this project."
                />
              </label>
              <label className="field">
                <span className="field__label">Quality check</span>
                <input
                  className="mono"
                  maxLength={1000}
                  value={project.check ?? ''}
                  onChange={(e) => updateProject(project.id, { check: e.target.value || undefined })}
                  placeholder="e.g. pnpm lint && pnpm test (runs in this folder, as the agents' user)"
                />
              </label>
            </>
          ) : (
            <div className="ws-project__setup">
              <span className="field__hint">Not a project in the dashboard yet. Set it up to give its tasks a brief and a quality check.</span>
              <button className="small" onClick={ensureProject}>
                <LuSettings2 /> Set up as project
              </button>
            </div>
          )}
        </div>

        {project && (
          <div className="field">
            <span className="field__label">Reports</span>
            <ProjectReports projectId={project.id} />
          </div>
        )}

        <div className="field">
          <span className="field__label">Open tasks</span>
          {!related.length ? (
            <span className="muted">None for the agents here.</span>
          ) : (
            <ul className="team-list">
              {related.map((t) => (
                <li key={t.id}>
                  <button className="team-row" onClick={() => openUrl({ task: t.id })}>
                    <span className="status-pill" style={{ ['--c' as string]: STATUS_BY_ID[t.status].color }}>
                      {STATUS_BY_ID[t.status].label}
                    </span>
                    <span className="team-row__body">
                      <span className="team-row__title truncate">{t.title}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="modal__foot">
          {orphan && (
            <button className="ghost danger-text" onClick={() => void removeFolder()}>
              <LuTrash2 /> Delete folder
            </button>
          )}
          <button
            className="primary"
            onClick={() => {
              openUrl({ newtask: '1', nt_agent: people[0]?.id ?? null, nt_project: ensureProject() })
            }}
          >
            <LuPlus /> New task here
          </button>
        </footer>
      </div>
    </Modal>
  )
}

function ProjectsRefresh({ ws }: { ws: ReturnType<typeof useWorkspaceData> }) {
  if (!ws.live) return null
  return (
    <button className="icon-btn small" data-tip="Read the folders again" aria-label="Refresh projects" onClick={() => void ws.refresh()} disabled={ws.loading}>
      <LuRefreshCw className={ws.loading ? 'spin' : ''} />
    </button>
  )
}

/** A new project with its own folder in ~/after-office/project (made by the server). */
export function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (folder: WorkspaceFolder) => void }) {
  const addProject = useDashboard((s) => s.addProject)
  const reload = useWorkspaces((s) => s.load)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const create = async () => {
    if (!name.trim()) return
    setBusy(true)
    const id = addProject(name.trim(), undefined, { createFolder: true })
    // wait for the server to make the folder, then open it
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300))
      const folder = useDashboard.getState().projects.find((p) => p.id === id)?.folder
      if (!folder) continue
      await reload(true)
      const f = useWorkspaces.getState().data?.flatMap((w) => w.projects).find((x) => x.path === folder)
      onClose()
      if (f) onCreated(f)
      return
    }
    setBusy(false)
    onClose()
  }
  return (
    <Modal open onClose={onClose} title="New project" description="It gets its own folder in ~/after-office/project" width={420}>
      <form
        className="modal__body"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <label className="field">
          <span className="field__label">Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. SEO" />
          <span className="field__hint">
            Folder: <code>~/after-office/project/{name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'name'}</code>. To use an
            agent's folder or a repo instead, open it above and choose "Set up as project".
          </span>
        </label>
        <footer className="modal__foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!name.trim() || busy}>
            <LuPlus /> {busy ? 'Creating…' : 'Create'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
