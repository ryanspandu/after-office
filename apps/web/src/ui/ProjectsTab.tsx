import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { matchesSearch } from './SearchBox'
import { LuCopy, LuFolder, LuFolderGit2, LuFolderPlus, LuGitBranch, LuGitCommitHorizontal, LuPlus, LuRefreshCw, LuSettings2, LuTrash2, LuEye, LuEyeOff, LuChevronRight, LuFolderOpen, LuCheck, LuX, LuListTodo, LuFileText, LuFile, LuRotateCcw, LuSquareTerminal, LuNotebookPen, LuMinus } from 'react-icons/lu'
import { DeleteProject } from './DeleteProject'
import { ProjectReports } from './Reports'
import { confirm } from './Confirm'
import { api } from '../state/auth'
import { FileBrowser } from './FileBrowser'
import { openUrl, setUrl } from '../state/url'
import type { GitCommit, Workspace, WorkspaceFolder } from '@after-office/shared'
import { useNow } from '../state/clock'
import { useDashboard } from '../state/dashboard'
import { liveApi } from '../state/live'
import { useWorkspaces } from '../state/workspaces'
import { useMinimized } from '../state/minimized'
import { useOffice, type OfficeAgent, avatarStyle } from '../state/store'
import { ago } from './FollowUps'
import { Modal } from './Modal'
import { useModalMaximize } from './Maximize'
import { FolderTerminal } from './FolderTerminal'
// the notes' rich text editor loads only when Notes is opened
const FolderNotes = lazy(() => import('./FolderNotes'))
import { formatSize } from './Attachments'
import { STATUS_BY_ID } from './taskMeta'
import { Previews } from './Previews'
import { Chevron, FolderTree, TreeContext, type ProjectAt } from './FolderTree'
import { closestCenter, DndContext, MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core'
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

// Projects tab: what the agents are working on, straight from their folders, in two lists. "Projects": the folders in
// the office's own projects folder (~/after-office/project, where new projects get a folder). "Agents": each agent's
// folder (a git repo is one project; any other folder holds one project per subfolder), and folders whose agent was
// removed (hideable). Folders are only read here; projects can be set up, renamed and deleted (with their folder, if
// the office made it).

type View = 'projects' | 'agents'
const VIEW_KEY = 'ao-projects-view'

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
  const [order, saveOrder] = useFolderOrder()
  // a mouse drags after moving a little (a click still opens); a finger after holding a moment (a swipe still scrolls)
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }))
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
  // which list: remembered in this browser
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'agents' ? 'agents' : 'projects'
    } catch {
      return 'projects'
    }
  })
  const pickView = (v: View) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* this visit only */
    }
  }
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
  // the office's projects folder: its subfolders are the Projects list
  const home = ws.data.find((w) => w.shared)
  // in the owner's order (dragged), new folders after the ordered ones
  const rank = (path: string) => {
    const i = order.indexOf(path)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  const homeProjects = (home?.projects ?? []).filter((p) => matchesSearch(q, p.name, p.path)).sort((a, b) => rank(a.path) - rank(b.path))
  const moveFolder = (from: string, to: string | null) => {
    if (!to || from === to) return
    const all = homeProjects.map((p) => p.path)
    saveOrder(arrayMove(all, all.indexOf(from), all.indexOf(to)))
  }
  // a search keeps the agent folders that match, or that hold a project that does (only those projects then)
  const shown = (showOrphans ? ws.data : ws.data.filter((w) => !w.orphan))
    .filter((w) => !w.shared)
    .map((w) => {
      if (!q.trim()) return w
      const people = w.agentIds.map((id) => agents.find((a) => a.id === id)?.name).join(' ')
      if (matchesSearch(q, w.name, w.path, people)) return w
      const projects = w.projects.filter((p) => matchesSearch(q, p.name, p.path))
      return projects.length ? { ...w, projects } : null
    })
    .filter((w): w is NonNullable<typeof w> => !!w)
  const count = shown.reduce((n, w) => n + (w.isProject ? 1 : w.projects.length), 0)
  const agentFolders = shown.length
  const summary =
    view === 'projects'
      ? `${homeProjects.length} project${homeProjects.length === 1 ? '' : 's'} in the projects folder`
      : `${count} project${count === 1 ? '' : 's'} in ${agentFolders} agent folder${agentFolders === 1 ? '' : 's'}${
          !showOrphans && orphans ? ` (${orphans} without an agent hidden)` : ''
        }`
  const tree = { isOpen: (k: string) => unfolded.has(k), toggle: toggleFold }
  return (
    <TreeContext.Provider value={tree}>
      <Previews />
      <div className="seg ws-tabs" role="tablist">
        <button role="tab" aria-selected={view === 'projects'} className={view === 'projects' ? 'active' : ''} onClick={() => pickView('projects')}>
          Projects
          <span className="seg__count">{home?.projects.length ?? 0}</span>
        </button>
        <button role="tab" aria-selected={view === 'agents'} className={view === 'agents' ? 'active' : ''} onClick={() => pickView('agents')}>
          Agents
          <span className="seg__count">{ws.data.filter((w) => !w.shared && !w.orphan).length}</span>
        </button>
      </div>
      <div className="ws-bar">
        {/* may be cut short in a narrow column: the whole line in a tooltip */}
        <span className="muted" data-tip={summary}>
          {summary}
        </span>
        <span className="grow" />
        <button className="icon-btn small" data-tip="New project" aria-label="New project" onClick={() => openUrl({ newproject: '1' })}>
          <LuFolderPlus />
        </button>
        {view === 'projects' && home && (
          <button className="icon-btn small" data-tip={`Open the projects folder · ${home.path}`} aria-label="Open the projects folder" onClick={() => setOpen({ folder: home, agentIds: home.agentIds })}>
            <LuFolderOpen />
          </button>
        )}
        {view === 'agents' && (
        <button
          className="icon-btn small"
          disabled={!orphans}
          onClick={toggleOrphans}
          data-tip={!orphans ? 'No folders without an agent' : showOrphans ? `Hide ${orphans} folder${orphans === 1 ? '' : 's'} with no agent` : `Show ${orphans} folder${orphans === 1 ? '' : 's'} with no agent`}
          aria-label={showOrphans ? 'Hide folders with no agent' : 'Show folders with no agent'}
        >
          {showOrphans ? <LuEyeOff /> : <LuEye />}
        </button>
        )}
        <ProjectsRefresh ws={ws} />
      </div>
      {view === 'projects' ? (
        <div className="ws-list">
          {!homeProjects.length ? (
            <div className="empty">{q.trim() ? 'No projects match.' : 'No projects yet. New projects get their folder in the projects folder.'}</div>
          ) : (
            // drag a folder to put it elsewhere in the list (not while searching: only some are shown)
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => moveFolder(String(e.active.id), e.over ? String(e.over.id) : null)}>
              <SortableContext items={homeProjects.map((p) => p.path)} strategy={verticalListSortingStrategy} disabled={!!q.trim()}>
                <ul className="ws__projects ws__projects--flat">
                  {homeProjects.map((p) => (
                    <SortableFolder
                      key={p.path}
                      id={p.path}
                      row={
                        <>
                          <Chevron open={unfolded.has(p.path)} onClick={() => toggleFold(p.path)} label={p.name} />
                          <FolderRow folder={p} now={now} onOpen={() => setOpen({ folder: p, agentIds: home?.agentIds ?? [] })} />
                        </>
                      }
                    >
                      {unfolded.has(p.path) && <FolderTree root={p.path} depth={1} onOpenDir={(path) => openUrl({ folder: path })} />}
                    </SortableFolder>
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          )}
        </div>
      ) : (
      <div className="ws-list">
        {!shown.length && <div className="empty">{q.trim() ? 'No folders match.' : 'No agent folders.'}</div>}
        {shown.map((w) => {
          const people = w.agentIds.map((id) => agents.find((a) => a.id === id)).filter(Boolean) as OfficeAgent[]
          // every folder opens in place (its files and subfolders); a search shows the matching projects instead
          const searching = !!q.trim() && !w.isProject
          const open = searching || unfolded.has(w.path)
          // its project subfolders: their tag and git line in the tree, their name opens their details
          const projectAt: ProjectAt = (abs) => {
            const p = w.projects.find((x) => x.path === abs || x.path.replace(/^\/private/, '') === abs.replace(/^\/private/, ''))
            return p ? { tag: <LinkedTag projectId={p.projectId} folderName={p.name} />, sub: <GitLine folder={p} now={now} compact />, open: () => setOpen({ folder: p, agentIds: w.agentIds }) } : undefined
          }
          return (
            <section key={w.path} className={`ws${w.orphan ? ' ws--orphan' : ''}`}>
              <div className="ws__top">
              <Chevron open={open} onClick={() => toggleFold(w.path)} label={w.name} />
              <button
                className="ws__head"
                onClick={() => setOpen({ folder: w, agentIds: w.agentIds, orphan: w.orphan })}
                data-tip={w.orphan ? 'Its agent was removed' : undefined}
              >
                {w.git ? <LuFolderGit2 className="ws__icon" /> : <LuFolder className="ws__icon" />}
                <span className="ws__name truncate">{w.shared ? 'Projects folder' : w.name}</span>
                {w.isProject && <LinkedTag projectId={w.projectId} folderName={w.name} />}
                {!w.isProject && !open && w.projects.length > 0 && <span className="ws__count muted" data-tip={`${w.projects.length} project${w.projects.length === 1 ? '' : 's'}`}>{w.projects.length}</span>}
                {w.orphan ? <span className="ws__tag ws__tag--orphan">no agent</span> : <Avatars agents={people} />}
              </button>
              </div>
              {w.isProject && <GitLine folder={w} now={now} block />}
              {!open ? null : !searching ? (
                <FolderTree root={w.path} depth={1} projectAt={projectAt} onOpenDir={(path) => openUrl({ folder: path })} />
              ) : w.projects.length ? (
                <ul className="ws__projects">
                  {w.projects.map((p) => (
                    <li key={p.path}>
                      <FolderRow folder={p} now={now} onOpen={() => setOpen({ folder: p, agentIds: w.agentIds })} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          )
        })}
      </div>
      )}
    </TreeContext.Provider>
  )
}

/** One project folder in a list: its name, the dashboard project it's linked to, its git state. */
function FolderRow({ folder: p, now, onOpen }: { folder: WorkspaceFolder; now: number; onOpen: () => void }) {
  return (
    <button className="ws-row" onClick={onOpen}>
      {p.git ? <LuFolderGit2 className="ws-row__icon" /> : <LuFolder className="ws-row__icon" />}
      <span className="ws-row__body">
        <span className="ws-row__name">
          <span className="truncate">{p.name}</span>
          <LinkedTag projectId={p.projectId} folderName={p.name} />
        </span>
        <GitLine folder={p} now={now} compact />
      </span>
    </button>
  )
}

/** The dashboard project a folder is linked to (colour + name), or a hint that it can be set up. */
function LinkedTag({ projectId }: { projectId?: string | null; folderName?: string }) {
  const project = useDashboard((s) => s.projects.find((p) => p.id === projectId))
  if (!project) return <span className="ws__tag">project</span>
  // a project of the dashboard (brief, check, tasks): its colour
  return <span className="chip__dot ws__dot-tag" style={{ background: project.color }} />
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

/** `onMinimize`: puts the window aside (a chip brings it back); `hidden`: it's minimized, kept mounted but not shown. */
export function ProjectFolderModal({
  open: { folder: f, agentIds, orphan },
  onClose,
  onMinimize,
  hidden,
}: {
  open: Open
  onClose: () => void
  onMinimize?: (section: Section) => void
  hidden?: boolean
}) {
  const agents = useOffice((s) => s.agents)
  const tasks = useDashboard((s) => s.tasks)
  const addProject = useDashboard((s) => s.addProject)
  const updateProject = useDashboard((s) => s.updateProject)
  // the project linked to this folder: from the scan, or one set up here a moment ago
  const project = useDashboard((s) => s.projects.find((p) => p.id === f.projectId || (p.folder && p.folder === f.path)))
  const reload = useWorkspaces((s) => s.load)
  // a folder in the projects folder can be renamed here (an agent's folder is named after its agent)
  const home = useWorkspaces((s) => s.data?.find((w) => w.shared))
  const renamable = !!home && f.path.startsWith(`${home.path}/`) && !f.path.slice(home.path.length + 1).includes('/')
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
  // the panel on the right: the files, or one of the folder's other sections (the sidebar)
  // back from a chip after a reload: on the section it was left on
  const [section, setSection] = useState<Section>(() => {
    const was = useMinimized.getState().folders.find((m) => m.path === f.path)?.section
    return SECTIONS.includes(was as Section) ? (was as Section) : 'files'
  })
  useEffect(() => useMinimized.getState().setSection(f.path, section), [f.path, section])
  const trash = useTrash(f.path)
  const max = useModalMaximize(1120)
  const tilde = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~')
  const nav: { id: Section; label: string; icon: React.ReactNode; count?: number; show?: boolean }[] = [
    { id: 'files', label: 'Files', icon: <LuFolderOpen /> },
    { id: 'notes', label: 'Notes', icon: <LuNotebookPen /> },
    { id: 'terminal', label: 'Terminal', icon: <LuSquareTerminal /> },
    { id: 'project', label: project ? 'Project settings' : 'Set up as project', icon: <LuSettings2 /> },
    { id: 'tasks', label: 'Open tasks', icon: <LuListTodo />, count: related.length },
    { id: 'reports', label: 'Reports', icon: <LuFileText />, show: !!project },
    { id: 'git', label: 'Git', icon: <LuGitBranch />, show: !!f.git },
    { id: 'trash', label: 'Trash', icon: <LuTrash2 />, count: trash.items?.length },
  ]

  return (
    <Modal
      open
      onClose={onClose}
      title={f.name}
      description={`${f.git ? 'Git repository' : 'Folder'} · ${tilde(f.path)}`}
      {...max.modalProps}
      hidden={hidden}
      // a click beside it puts it aside (minimized) instead of closing it
      onBackdrop={onMinimize ? () => onMinimize(section) : undefined}
      className={`${max.modalProps.className ?? ''} fd-modal`}
      actions={
        <>
          <button
            className="icon-btn small ghost"
            data-tip={copied ? 'Copied' : 'Copy path'}
            aria-label="Copy path"
            onClick={() => void navigator.clipboard?.writeText(f.path).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1200)))}
          >
            {copied ? <LuCheck /> : <LuCopy />}
          </button>
          {onMinimize && (
            <button className="icon-btn small ghost" data-tip="Minimize" aria-label="Minimize" onClick={() => onMinimize(section)}>
              <LuMinus />
            </button>
          )}
          {max.modalProps.actions}
        </>
      }
    >
      <div className="modal__body fd" ref={max.bodyRef}>
        <aside className="fd__side">
          <nav className="fd__nav" aria-label="Folder">
            {nav
              .filter((n) => n.show !== false)
              .map((n) => (
                <button key={n.id} className={`fd__navbtn${section === n.id ? ' is-on' : ''}`} onClick={() => setSection(n.id)} aria-current={section === n.id}>
                  {n.icon}
                  <span className="truncate">{n.label}</span>
                  {!!n.count && <span className="fd__count">{n.count}</span>}
                </button>
              ))}
          </nav>
          <div className="fd__agents">
            <span className="fd__label">Agents here</span>
            {!people.length && <span className="muted fd__none">{orphan ? 'None: its agent was removed.' : 'None.'}</span>}
            {people.map((a) => (
              <span key={a.id} className="fd__agent">
                <span className="chip__dot" style={{ background: a.look.shirt }} />
                <span className="truncate">{a.name}</span>
                <span className="muted">{a.status}</span>
              </span>
            ))}
          </div>
          <div className="fd__actions">
            <button className="primary" onClick={() => openUrl({ newtask: '1', nt_agent: people[0]?.id ?? null, nt_project: ensureProject() })}>
              <LuPlus /> New task here
            </button>
            {orphan && (
              <button className="ghost danger-text" onClick={() => void removeFolder()}>
                <LuTrash2 /> Delete folder
              </button>
            )}
            {/* deleting the project: apart from the settings (asks first; the folder only if ticked) */}
            {project && <DeleteProject labelled project={project} taskCount={tasks.filter((t) => t.projectId === project.id).length} onDeleted={onClose} />}
          </div>
        </aside>

        <section className="fd__main">
          {section === 'files' && <FileBrowser root={f.path} fill onTrashed={trash.reload} />}
          {section === 'terminal' && <FolderTerminal root={f.path} />}
          {section === 'notes' && (
            <Suspense fallback={<div className="fd__panel muted">Loading…</div>}>
              <FolderNotes path={f.path} />
            </Suspense>
          )}

          {section === 'project' && (
            <div className="fd__panel">
              {renamable && <FolderName folder={f} />}
              {project ? (
                <>
                  <p className="field__hint ws-project__hint">Its tasks work in this folder, get the brief below, and run the check when they finish.</p>
                  <label className="field">
                    <span className="field__label">Brief</span>
                    <textarea
                      rows={6}
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
          )}

          {section === 'tasks' && (
            <div className="fd__panel">
              {!related.length ? (
                <span className="muted">No open tasks for the agents here.</span>
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
          )}

          {section === 'reports' && project && (
            <div className="fd__panel">
              <ProjectReports projectId={project.id} />
            </div>
          )}

          {section === 'git' && f.git && (
            <div className="fd__panel">
              <span className="field__label">
                <GitLine folder={f} now={now} compact />
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

          {section === 'trash' && <TrashPanel trash={trash} now={now} tilde={tilde} under={f.path} />}
        </section>
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

/** The name of a folder in the projects folder: renaming it renames the folder (its project follows). */
function FolderName({ folder }: { folder: WorkspaceFolder }) {
  const reload = useWorkspaces((s) => s.load)
  const [name, setName] = useState(folder.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setName(folder.name), [folder.name])
  const changed = name.trim() !== '' && name.trim() !== folder.name
  const save = async () => {
    if (!changed || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await api('/api/workspaces/rename', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folder.path, name: name.trim() }) })
      const body = await r.json().catch(() => null)
      if (!r.ok) throw new Error(body?.error ?? 'Could not rename it')
      await reload(true)
      // the details follow the folder to its new place
      setUrl({ folder: body.folder })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <label className="field grow">
      <span className="field__label">Folder name</span>
      <span className="ws-rename">
        <input
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
            if (e.key === 'Escape' && changed) {
              e.stopPropagation()
              setName(folder.name)
            }
          }}
        />
        {changed && (
          <>
            <button type="button" className="icon-btn small ghost" onClick={() => void save()} disabled={busy} data-tip="Rename" aria-label="Rename the folder">
              {busy ? <LuRefreshCw className="spin" /> : <LuCheck />}
            </button>
            <button
              type="button"
              className="icon-btn small ghost"
              onClick={() => {
                setName(folder.name)
                setError(null)
              }}
              disabled={busy}
              data-tip="Cancel"
              aria-label="Keep the old name"
            >
              <LuX />
            </button>
          </>
        )}
      </span>
      {(changed || error) && <span className={`field__hint${error ? ' danger-text' : ''}`}>{error ?? 'Renames the folder itself (letters, numbers and dashes); the project keeps its brief, check and tasks.'}</span>}
    </label>
  )
}

const SECTIONS = ['files', 'terminal', 'notes', 'project', 'tasks', 'reports', 'git', 'trash'] as const
type Section = (typeof SECTIONS)[number]

interface TrashItem {
  id: string
  name: string
  original: string
  dir: boolean
  size: number
  deletedAt: number
}

/** What went to the trash from inside a folder (the office's trash, ~/after-office/.trash). */
function useTrash(under: string) {
  const [items, setItems] = useState<TrashItem[] | null>(null)
  const reload = useCallback(() => {
    void api(`/api/trash?${new URLSearchParams({ under })}`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setItems)
      .catch(() => setItems([]))
  }, [under])
  useEffect(reload, [reload])
  return { items, reload }
}

/** The folder's trash: restore an item where it was, delete it for good, or empty it. */
function TrashPanel({ trash, now, tilde, under }: { trash: ReturnType<typeof useTrash>; now: number; tilde: (p: string) => string; under: string }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const act = async (id: string, fn: () => Promise<Response>) => {
    setBusy(id)
    setError(null)
    try {
      const r = await fn()
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Failed')
      trash.reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const forget = async (i: TrashItem) => {
    if (!(await confirm({ title: `Delete “${i.name}” for good?`, message: 'It can’t be restored after this.', confirmLabel: 'Delete for good' }))) return
    await act(i.id, () => api(`/api/trash/${i.id}`, { method: 'DELETE' }))
  }
  const empty = async () => {
    const n = trash.items?.length ?? 0
    if (!(await confirm({ title: `Empty the trash of this folder?`, message: `${n} item${n === 1 ? '' : 's'} deleted for good. This can’t be undone.`, confirmLabel: 'Empty trash' }))) return
    await act('all', () => api(`/api/trash?${new URLSearchParams({ under })}`, { method: 'DELETE' }))
  }
  return (
    <div className="fd__panel">
      <div className="fd__trash-head">
        <span className="field__hint">Deleted from this folder. Kept in ~/after-office/.trash (never inside the project) until you empty it.</span>
        <span className="grow" />
        {!!trash.items?.length && (
          <button className="small danger-text" onClick={() => void empty()} disabled={busy === 'all'}>
            <LuTrash2 /> Empty trash
          </button>
        )}
      </div>
      {error && <div className="row__error">{error}</div>}
      {!trash.items ? (
        <span className="muted">Loading…</span>
      ) : !trash.items.length ? (
        <span className="muted">The trash is empty.</span>
      ) : (
        <ul className="fd__trash">
          {trash.items.map((i) => (
            <li key={i.id}>
              {i.dir ? <LuFolder className="fb__folder" /> : <LuFile className="muted" />}
              <span className="fd__trash-body">
                <span className="truncate">{i.name}</span>
                <span className="muted truncate" data-tip={i.original}>
                  {tilde(i.original.slice(0, i.original.length - i.name.length - 1))} · {formatSize(i.size)} · {ago(now - i.deletedAt)}
                </span>
              </span>
              <button className="small" onClick={() => void act(i.id, () => api(`/api/trash/${i.id}/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))} disabled={busy === i.id}>
                <LuRotateCcw /> Restore
              </button>
              <button className="icon-btn small ghost danger-text" onClick={() => void forget(i)} disabled={busy === i.id} aria-label={`Delete ${i.name} for good`} data-tip="Delete for good">
                <LuX />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The owner's order of the projects folder's folders (kept on the server: the same on every device). */
function useFolderOrder(): [string[], (paths: string[]) => void] {
  const [order, setOrder] = useState<string[]>([])
  useEffect(() => {
    void api('/api/workspaces/order')
      .then((r) => (r.ok ? r.json() : { paths: [] }))
      .then((r: { paths: string[] }) => setOrder(r.paths))
      .catch(() => {})
  }, [])
  const save = (paths: string[]) => {
    setOrder(paths)
    void api('/api/workspaces/order', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths }) }).catch(() => {})
  }
  return [order, save]
}

/** One folder of the list, dragged by its row (not by what's open under it) to another place in the list. */
function SortableFolder({ id, row, children }: { id: string; row: React.ReactNode; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <li ref={setNodeRef} className={`tree-root${isDragging ? ' is-dragging' : ''}`} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <div className="tree-root__row" {...attributes} {...listeners}>
        {row}
      </div>
      {children}
    </li>
  )
}
