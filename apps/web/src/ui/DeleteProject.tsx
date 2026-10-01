import { LuTrash2 } from 'react-icons/lu'
import type { Project } from '@after-office/shared'
import { useDashboard } from '../state/dashboard'
import { liveApi } from '../state/live'
import { useOffice } from '../state/store'
import { useWorkspaces } from '../state/workspaces'
import { confirmWith } from './Confirm'

// Delete a project, and (optional, off by default) the folder the office made for it in <agents dir>/project.
// Folders it merely points at (an agent's folder, a repo) are never offered for deletion.

const tilde = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~')

/** `labelled`: a "Delete project" button (a modal's footer) instead of the bare icon (a list row). */
export function DeleteProject({ project: p, taskCount, onDeleted, labelled }: { project: Project; taskCount: number; onDeleted?: () => void; labelled?: boolean }) {
  const live = useOffice((s) => s.source === 'live')
  const removeProject = useDashboard((s) => s.removeProject)

  const ask = async () => {
    const folder = live && p.folder ? await liveApi.projectFolder(p.id) : null
    const items = folder?.entries ?? 0
    const { ok, option } = await confirmWith({
      title: `Delete the project “${p.name}”?`,
      message: taskCount ? (
        <>
          Its {taskCount} task{taskCount === 1 ? '' : 's'} stay, without a project.
          {p.folder && !folder?.deletable && <> Its folder <code>{tilde(p.folder)}</code> stays.</>}
        </>
      ) : p.folder && !folder?.deletable ? (
        <>
          Its folder <code>{tilde(p.folder)}</code> stays.
        </>
      ) : undefined,
      option: folder?.deletable
        ? {
            label: (
              <>
                Also delete its folder <code>{tilde(p.folder!)}</code>
              </>
            ),
            hint: items ? `${items >= 10_000 ? '10,000+' : items} item${items === 1 ? '' : 's'} in it, gone for good.` : 'It is empty.',
          }
        : undefined,
    })
    if (!ok) return
    removeProject(p.id, { folder: option })
    // the Projects tab drops the folder once it's gone
    if (option) setTimeout(() => void useWorkspaces.getState().load(true), 800)
    onDeleted?.()
  }

  if (labelled)
    return (
      <button className="ghost danger-text" data-tip={taskCount ? 'Its tasks stay, without a project' : undefined} onClick={ask}>
        <LuTrash2 /> Delete project
      </button>
    )
  return (
    <button className="icon-btn small ghost" data-tip={taskCount ? 'Delete project (its tasks stay, without a project)' : 'Delete project'} aria-label="Delete project" onClick={ask}>
      <LuTrash2 />
    </button>
  )
}
