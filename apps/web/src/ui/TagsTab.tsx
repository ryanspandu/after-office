import { useState } from 'react'
import { matchesSearch } from './SearchBox'
import { LuPencil, LuTrash2 } from 'react-icons/lu'
import type { Tag } from '@after-office/shared'
import { useDashboard } from '../state/dashboard'
import { confirm } from './Confirm'
import { TagModal } from './TagModal'
import { TagIcon } from './tagIcons'
import { tip } from './Tooltip'

// The Tags tab (left sidebar, next to Tasks and Projects): the tags, each made and changed (name, colour, icon) in a
// modal, and deleted. Tags are also made right in a task's or report's tag picker.

export function TagsTab({ q = '' }: { q?: string }) {
  const allTags = useDashboard((s) => s.tags)
  const tags = allTags.filter((t) => matchesSearch(q, t.name))
  const tasks = useDashboard((s) => s.tasks)
  const reports = useDashboard((s) => s.reports)
  const removeTag = useDashboard((s) => s.removeTag)
  // the tag being edited (a new one is made from the + beside the search box, ui/LeftSidebar.tsx)
  const [editing, setEditing] = useState<Tag | null>(null)

  const uses = (id: string) => ({ tasks: tasks.filter((t) => t.tags?.includes(id)).length, reports: reports.filter((r) => r.tags?.includes(id)).length })
  const remove = async (t: Tag) => {
    const u = uses(t.id)
    const where = [u.tasks && `${u.tasks} task${u.tasks === 1 ? '' : 's'}`, u.reports && `${u.reports} report${u.reports === 1 ? '' : 's'}`].filter(Boolean).join(' and ')
    if (!(await confirm({ title: `Delete the tag "${t.name}"?`, message: where ? `It's taken off ${where} (and any older ones). The tasks and reports stay.` : 'Nothing uses it right now.', confirmLabel: 'Delete tag' }))) return
    removeTag(t.id)
  }

  return (
    <div className="tags-tab">
      {!tags.length ? (
        <p className="empty">{allTags.length ? 'No tags match.' : "No tags yet. Make one here, or type a new name in a task's or report's tag picker."}</p>
      ) : (
        <ul className="list tags-modal__list">
          {tags.map((t) => {
            const u = uses(t.id)
            return (
              <li key={t.id} className="tags-modal__row tags-tab__row" style={{ ['--c' as string]: t.color }}>
                <span className="tag-card__icon tags-tab__icon">
                  <TagIcon tag={t} />
                </span>
                <span className="tags-tab__name truncate">{t.name}</span>
                <span className="tags-modal__uses muted">
                  {u.tasks} task{u.tasks === 1 ? '' : 's'} · {u.reports} report{u.reports === 1 ? '' : 's'}
                </span>
                <button type="button" className="icon-btn small ghost" onClick={() => setEditing(t)} {...tip(`Edit ${t.name}`)} aria-label={`Edit ${t.name}`}>
                  <LuPencil />
                </button>
                <button type="button" className="icon-btn small ghost" onClick={() => void remove(t)} {...tip(`Delete ${t.name}`)} aria-label={`Delete ${t.name}`}>
                  <LuTrash2 />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {editing && <TagModal tag={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
