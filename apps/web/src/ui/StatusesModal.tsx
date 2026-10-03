import { useState } from 'react'
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { LuGripVertical, LuLock, LuPlus, LuTrash2 } from 'react-icons/lu'
import type { TaskStatus, TaskStatusDef } from '@after-office/shared'
import { liveApi } from '../state/live'
import { useDashboard } from '../state/dashboard'
import { Modal } from './Modal'
import { TAG_COLORS } from './tags'
import { statusDefOf, useStatuses, withBases } from './taskMeta'
import { confirm } from './Confirm'

// The owner's task statuses (Tasks → Statuses, or "Edit statuses…" in any status picker): the board's columns, in
// order. The four built-in ones can be renamed, recoloured and moved, not removed (the office goes by them); the
// owner's own each count as one of them (that's what an agent, a chain of tasks or the archive sees).

const isBuiltIn = (d: TaskStatusDef) => d.id === d.base

export function StatusesModal({ onClose }: { onClose: () => void }) {
  const saved = useStatuses()
  const tasks = useDashboard((s) => s.tasks)
  const [list, setList] = useState<TaskStatusDef[]>(saved)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const changed = JSON.stringify(list) !== JSON.stringify(saved)
  const count = (d: TaskStatusDef) => tasks.filter((t) => statusDefOf(t, saved).id === d.id).length

  const edit = (id: string, patch: Partial<TaskStatusDef>) => setList((l) => l.map((d) => (d.id === id ? { ...d, ...patch } : d)))
  // a new one goes just before "Done" (at the very end it would work like done: its tasks finished)
  const add = () =>
    setList((l) => {
      const at = l.findIndex((d) => d.id === 'done')
      const fresh: TaskStatusDef = { id: `new-${Date.now().toString(36)}`, label: 'New status', color: TAG_COLORS[l.length % TAG_COLORS.length], base: 'in_progress' as TaskStatus }
      return at < 0 ? [...l, fresh] : [...l.slice(0, at), fresh, ...l.slice(at)]
    })
  const remove = async (d: TaskStatusDef) => {
    const n = count(d)
    if (n && !(await confirm({ title: `Remove "${d.label}"?`, message: `Its ${n} task${n === 1 ? '' : 's'} go back to "${saved.find((s) => s.id === d.base)?.label}".`, confirmLabel: 'Remove' }))) return
    setList((l) => l.filter((x) => x.id !== d.id))
  }
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    setList((l) => arrayMove(l, l.findIndex((d) => d.id === e.active.id), l.findIndex((d) => d.id === e.over!.id)))
  }
  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      // new ones go without an id: the server gives them one
      await liveApi.saveStatuses(withBases(list).map((d) => (d.id.startsWith('new-') ? { ...d, id: '' } : d)))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Statuses" description="The board's columns, in order (drag to move them, here or on the board). Your own statuses work like the built-in one to their left." width={560}>
      <div className="modal__body statuses">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={list.map((d) => d.id)} strategy={verticalListSortingStrategy}>
            <ul className="statuses__list">
              {list.map((d) => (
                <StatusRow key={d.id} d={d} actsAs={saved.find((s) => s.id === withBases(list).find((x) => x.id === d.id)?.base)?.label ?? ''} tasks={saved.some((s) => s.id === d.id) ? count(d) : 0} onEdit={(p) => edit(d.id, p)} onRemove={() => void remove(d)} />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
        <button type="button" className="small statuses__add" onClick={add} disabled={list.length >= 20}>
          <LuPlus /> Add status
        </button>
        {error && <p className="danger-text statuses__error">{error}</p>}
        <footer className="modal__foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <span className="grow" />
          <button type="button" className="primary" onClick={() => void save()} disabled={!changed || saving || list.some((d) => !d.label.trim())}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </Modal>
  )
}

function StatusRow({ d, actsAs, tasks, onEdit, onRemove }: { d: TaskStatusDef; actsAs: string; tasks: number; onEdit: (p: Partial<TaskStatusDef>) => void; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: d.id })
  const [colors, setColors] = useState(false)
  const builtIn = isBuiltIn(d)
  return (
    <li ref={setNodeRef} className={`statuses__row${isDragging ? ' is-dragging' : ''}`} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <button type="button" className="icon-btn small ghost statuses__grip" aria-label={`Move ${d.label}`} {...attributes} {...listeners}>
        <LuGripVertical />
      </button>
      <span className="statuses__color">
        <button type="button" className="statuses__dot" style={{ background: d.color }} aria-label="Colour" aria-expanded={colors} onClick={() => setColors((v) => !v)} />
        {colors && (
          <span className="statuses__palette" role="listbox" aria-label="Colour">
            {TAG_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="option"
                aria-selected={c === d.color}
                className={c === d.color ? 'is-on' : ''}
                style={{ background: c }}
                onClick={() => (onEdit({ color: c }), setColors(false))}
              />
            ))}
          </span>
        )}
      </span>
      <input className="statuses__name" value={d.label} maxLength={30} onChange={(e) => onEdit({ label: e.target.value })} aria-label="Name" />
      {builtIn ? (
        <span className="statuses__base muted" data-tip="Built in: the office goes by it (it can be renamed, not removed)">
          <LuLock /> Built in
        </span>
      ) : (
        <span className="statuses__base muted" data-tip="From its place: it works like the built-in status left of it">
          like {actsAs}
        </span>
      )}
      <span className="statuses__count muted">{tasks ? `${tasks}` : ''}</span>
      {builtIn ? (
        <span className="statuses__del" />
      ) : (
        <button type="button" className="icon-btn small ghost statuses__del" aria-label={`Remove ${d.label}`} data-tip="Remove" onClick={onRemove}>
          <LuTrash2 />
        </button>
      )}
    </li>
  )
}
