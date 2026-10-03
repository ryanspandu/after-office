import { useState } from 'react'
import { matchesSearch } from './SearchBox'
import { LuEllipsis, LuFileText, LuListTodo, LuPencil, LuTrash2 } from 'react-icons/lu'
import type { Tag } from '@after-office/shared'
import { useDashboard } from '../state/dashboard'
import { confirm } from './Confirm'
import { TagModal } from './TagModal'
import { ActionMenu } from './ActionMenu'
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
  // a tag's ⋯ menu (Edit, Delete)
  const [menu, setMenu] = useState<{ tag: Tag; x: number; y: number } | null>(null)

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
                {/* how much uses it: tasks and reports, as icons (the words on hover) */}
                <span className="tags-tab__uses muted">
                  <span {...tip(`${u.tasks} task${u.tasks === 1 ? '' : 's'}`)}>
                    <LuListTodo /> {u.tasks}
                  </span>
                  <span {...tip(`${u.reports} report${u.reports === 1 ? '' : 's'}`)}>
                    <LuFileText /> {u.reports}
                  </span>
                </span>
                <button
                  type="button"
                  className="icon-btn small ghost"
                  aria-label={`Actions for ${t.name}`}
                  aria-expanded={menu?.tag.id === t.id}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    setMenu(menu?.tag.id === t.id ? null : { tag: t, x: r.right, y: r.bottom + 4 })
                  }}
                >
                  <LuEllipsis />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {menu && (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          title={menu.tag.name}
          onClose={() => setMenu(null)}
          actions={[
            { icon: <LuPencil />, label: 'Edit', run: () => setEditing(menu.tag) },
            { icon: <LuTrash2 />, label: 'Delete', danger: true, run: () => void remove(menu.tag) },
          ]}
        />
      )}
      {editing && <TagModal tag={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
