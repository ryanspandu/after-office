import { useEffect, useState } from 'react'
import { LuChevronDown, LuPlus } from 'react-icons/lu'
import { DeleteProject } from './DeleteProject'
import type { Project } from '@after-office/shared'
import { api } from '../state/auth'
import { useDashboard } from '../state/dashboard'
import { useOffice } from '../state/store'
import { Field, Modal } from './Modal'
import { Select } from './Select'
import { projectFolders, useWorkspaces } from '../state/workspaces'

// Projects: a name and colour for grouping tasks, plus (live) a brief that goes into every task prompt of the
// project, and a quality check the server runs in the agent's folder when a task is finished.

const COLORS = ['#e8762c', '#f4b817', '#2fbf71', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#9a9a96']

export function ProjectsModal({ onClose }: { onClose: () => void }) {
  const projects = useDashboard((s) => s.projects)
  const tasks = useDashboard((s) => s.tasks)
  const addProject = useDashboard((s) => s.addProject)
  const live = useOffice((s) => s.source === 'live')
  const reload = useWorkspaces((s) => s.load)
  const [openId, setOpenId] = useState<string | null>(null)
  const [name, setName] = useState('')

  const add = () => {
    if (!name.trim()) return
    // live: it gets its own folder, <agents dir>/project/<name> (changeable below)
    setOpenId(addProject(name.trim(), undefined, { createFolder: live }))
    setName('')
    if (live) setTimeout(() => void reload(true), 800)
  }

  return (
    <Modal open onClose={onClose} title="Projects" description="Group tasks, and give agents the context and checks they need" width={620}>
      <div className="modal__body projects">
        <form
          className="projects__add"
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project name" maxLength={60} aria-label="New project name" />
          <button className="small primary" disabled={!name.trim()}>
            <LuPlus /> Add
          </button>
        </form>
        {!projects.length && <div className="empty">No projects yet.</div>}
        <ul className="projects__list">
          {projects.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              count={tasks.filter((t) => t.projectId === p.id).length}
              open={openId === p.id}
              onToggle={() => setOpenId(openId === p.id ? null : p.id)}
            />
          ))}
        </ul>
      </div>
    </Modal>
  )
}

function ProjectRow({ project: p, count, open, onToggle }: { project: Project; count: number; open: boolean; onToggle: () => void }) {
  const updateProject = useDashboard((s) => s.updateProject)
  const live = useOffice((s) => s.source === 'live')
  const set = (patch: Partial<Project>) => updateProject(p.id, patch)

  return (
    <li className={`projects__item${open ? ' is-open' : ''}`}>
      <div className="projects__line">
        <button className="team-row" onClick={onToggle} aria-expanded={open}>
          <LuChevronDown className={`archive__chev${open ? ' archive__chev--open' : ''}`} />
          <span className="chip__dot" style={{ background: p.color }} />
          <span className="team-row__body">
            <span className="team-row__title truncate">{p.name}</span>
            <span className="team-row__meta truncate">
              {count} task{count === 1 ? '' : 's'}
              {p.brief ? ' · brief' : ''}
              {p.check ? ` · check: ${p.check}` : ''}
            </span>
          </span>
        </button>
        <DeleteProject project={p} taskCount={count} />
      </div>
      {open && (
        <div className="projects__edit">
          <div className="projects__row">
            <Field label="Name">
              <input value={p.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            {/* not a <label>: it would forward clicks to the first swatch */}
            <div className="field">
              <span className="field__label">Colour</span>
              <div className="projects__colors" role="radiogroup" aria-label="Colour">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={p.color === c}
                    aria-label={c}
                    className={`projects__color${p.color === c ? ' is-on' : ''}`}
                    style={{ background: c }}
                    onClick={() => set({ color: c })}
                  />
                ))}
              </div>
            </div>
          </div>
          {live && (
            <>
              <div className="field">
                <span className="field__label">Folder</span>
                <FolderSelect
                  value={p.folder ?? ''}
                  onChange={(folder) => {
                    if (folder !== NEW_FOLDER) return set({ folder })
                    // the server makes ~/after-office/project/<name> and sends the project back with it
                    const { folder: _none, ...rest } = p
                    void api(`/api/projects/${p.id}`, { method: 'PUT', body: JSON.stringify({ ...rest, createFolder: true }) }).then(async (r) => {
                      if (!r.ok) useDashboard.setState({ syncError: (await r.json().catch(() => null))?.error ?? 'Could not make the folder' })
                      setTimeout(() => void useWorkspaces.getState().load(true), 500)
                    })
                  }}
                />
                <span className="field__hint">
                  Where its tasks happen: agents are told to work there, and the check and the Changes view run there. New projects get their own
                  folder in ~/after-office/project; an agent's folder or a repo works too.
                </span>
              </div>
              <Field label="Brief" hint="Goal, where the code lives, conventions. Added to the prompt of every task in this project (and seen by the manager).">
                <textarea
                  rows={4}
                  maxLength={5000}
                  value={p.brief ?? ''}
                  onChange={(e) => set({ brief: e.target.value || undefined })}
                  placeholder={'e.g. Online shop. Repo ~/projects/shop (Next.js, pnpm). Keep changes small; write tests for new logic.'}
                />
              </Field>
              <Field
                label="Quality check"
                hint="Runs in the project's folder (as the agents' user) when an agent finishes a task. If it fails, the agent gets the output and tries to fix it (twice) before it comes to you."
              >
                <input className="mono" value={p.check ?? ''} maxLength={1000} onChange={(e) => set({ check: e.target.value || undefined })} placeholder="e.g. pnpm lint && pnpm test" />
              </Field>
            </>
          )}
        </div>
      )}
    </li>
  )
}

const NEW_FOLDER = '__new__'

/** A project's folder: one of the folders the agents work in (read from the server), or none. */
function FolderSelect({ value, onChange }: { value: string; onChange: (folder: string) => void }) {
  const data = useWorkspaces((s) => s.data)
  const load = useWorkspaces((s) => s.load)
  useEffect(() => {
    void load()
  }, [load])
  // the projects folder's own ones first, then the agents'
  const folders = projectFolders([...(data ?? []).filter((w) => w.shared), ...(data ?? []).filter((w) => !w.shared)]).map((f) => f.path)
  const options = [
    { value: '', label: 'No folder' },
    ...(value ? [] : [{ value: NEW_FOLDER, label: 'New folder in ~/after-office/project' }]),
    ...[...new Set([...(value ? [value] : []), ...folders])].map((path) => ({ value: path, label: path.replace(/^\/(Users|home)\/[^/]+/, '~') })),
  ]
  return <Select ariaLabel="Folder" searchable value={value} options={options} onChange={onChange} />
}
