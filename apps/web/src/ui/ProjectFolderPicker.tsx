import { useEffect, useState } from 'react'
import { LuFolder } from 'react-icons/lu'
import { useWorkspaces } from '../state/workspaces'
import { useOffice } from '../state/store'
import { Modal } from './Modal'
import { Chevron, FolderTree, TreeContext, UseButton, type PickDir } from './FolderTree'

// Choose any folder the agents work in, however deep (the project picker's "Browse folders…"): the projects folder's
// folders and each agent's folder, opened as a tree; "Use" picks one.

export function ProjectFolderPicker({ onPick, onClose }: { onPick: PickDir; onClose: () => void }) {
  const data = useWorkspaces((s) => s.data)
  const load = useWorkspaces((s) => s.load)
  const agents = useOffice((s) => s.agents)
  const [open, setOpen] = useState<Set<string>>(new Set())
  useEffect(() => void load(), [load])
  const toggle = (k: string) =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (!next.delete(k)) next.add(k)
      return next
    })
  const home = data?.find((w) => w.shared)
  const roots = [
    ...(home?.projects ?? []).map((p) => ({ path: p.path, name: p.name, hint: 'projects folder' })),
    ...(data ?? [])
      .filter((w) => !w.shared && !w.orphan)
      .map((w) => ({ path: w.path, name: w.name, hint: w.agentIds.map((id) => agents.find((a) => a.id === id)?.name).filter(Boolean).join(', ') || 'agent folder' })),
  ]
  const pick: PickDir = (path, name) => {
    onPick(path, name)
    onClose()
  }
  return (
    <Modal open onClose={onClose} title="Choose a folder" description="Open a folder to go deeper; “Use” picks it as the project's folder." width={560}>
      <div className="modal__body folder-picker">
        {!data ? (
          <div className="muted">Loading…</div>
        ) : !roots.length ? (
          <div className="empty">No folders yet.</div>
        ) : (
          <TreeContext.Provider value={{ isOpen: (k) => open.has(k), toggle }}>
            <ul className="tree">
              {roots.map((r) => (
                <li key={r.path}>
                  <div className="tree__row tree__dir" style={{ ['--depth' as string]: 0 }}>
                    <Chevron open={open.has(r.path)} onClick={() => toggle(r.path)} label={r.name} />
                    <button className="tree__open" onClick={() => toggle(r.path)}>
                      <LuFolder className="tree__icon tree__icon--dir" />
                      <span className="tree__name-wrap">
                        <span className="tree__name truncate">{r.name}</span>
                        <span className="muted folder-picker__hint truncate">{r.hint}</span>
                      </span>
                    </button>
                    <UseButton onClick={() => pick(r.path, r.name)} />
                  </div>
                  {open.has(r.path) && <FolderTree root={r.path} depth={1} pick={pick} />}
                </li>
              ))}
            </ul>
          </TreeContext.Provider>
        )}
      </div>
    </Modal>
  )
}
