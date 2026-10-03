import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { LuEllipsis, LuFileText, LuFolder, LuFolders, LuListTodo, LuNotebookPen, LuX } from 'react-icons/lu'
import { useLive } from '../state/live'
import { useMinimized, type MinimizedFolder } from '../state/minimized'
import { MOBILE, useMediaQuery } from '../state/useMediaQuery'
import { usePresence } from '../state/usePresence'
import { openUrl } from '../state/url'

const tilde = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~')
/** How a minimized window shows: its name, what's under it in a list, its icon, and how it opens again. */
function useWindowLabels() {
  const notes = useLive((s) => s.notes)
  return (f: MinimizedFolder) =>
    f.kind === 'report'
      ? {
          name: f.label || 'Report',
          sub: 'Report',
          icon: <LuFileText />,
          open: () => (useMinimized.getState().remove(f.path), openUrl({ report: f.path.slice('report:'.length) })),
        }
      : f.kind === 'notes'
      ? {
          name: 'Notes',
          sub: 'Notes',
          icon: <LuNotebookPen />,
          // back as it was left (the tag it was in, the search)
          open: () => (useMinimized.getState().remove(f.path), openUrl({ notes: '1', ...f.params })),
        }
      : f.kind === 'tasks' || f.kind === 'reports'
      ? {
          name: f.kind === 'tasks' ? 'Tasks' : 'Reports',
          sub: f.kind === 'tasks' ? 'Tasks' : 'Reports',
          icon: f.kind === 'tasks' ? <LuListTodo /> : <LuFileText />,
          // back as it was left (search, sort, page…); the chip goes, the window is open again
          open: () => (useMinimized.getState().remove(f.path), openUrl({ [f.kind as string]: f.kind === 'tasks' ? '1' : 'all', ...f.params })),
        }
      : f.kind === 'note'
      ? { name: notes.find((n) => n.id === f.path)?.title || f.label || 'Untitled note', sub: 'Note', icon: <LuNotebookPen />, open: () => openUrl({ note: f.path }) }
      : { name: f.path.split('/').pop() || f.path, sub: tilde(f.path), icon: <LuFolder />, open: () => openUrl({ folder: f.path }) }
}

/**
 * The minimized folder windows: a click opens one again as it was left, ✕ closes it for good. Larger screens: chips at
 * the bottom centre. Phones: one round button on the 3D stage, above the menu button (the dock, the menu and the app's
 * reload button keep their places), with the list opening upwards from it.
 */
export function MinimizedChips({ current, currentNote }: { current?: string; currentNote?: string }) {
  const live = useMinimized((s) => s.folders).filter((f) => (f.kind === 'note' ? f.path !== currentNote : f.path !== current))
  // a chip that goes (opened again, or closed) stays a moment to shrink away; a new one grows in (styles/projects.css)
  const folders = useLeaving(live)
  const labels = useWindowLabels()
  const remove = useMinimized((s) => s.remove)
  const move = useMinimized((s) => s.move)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  // the click that ends a drag (the pointer lifted over the chip it moved) doesn't open it
  const dragged = useRef(false)
  const mobile = useMediaQuery(MOBILE)
  if (!folders.length) return null
  if (mobile) return <MinimizedMenu folders={folders} remove={remove} />
  // many of them: the first few as chips, the rest behind "⋯" (with how many)
  const shown = folders.length > MAX_CHIPS ? folders.slice(0, MAX_CHIPS - 1) : folders
  const rest = folders.slice(shown.length)
  return (
    <div className="fmin" role="toolbar" aria-label="Minimized folders">
      {/* dragged into another order (a few pixels first: a plain click still opens one) */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={() => (dragged.current = true)}
        onDragCancel={() => setTimeout(() => (dragged.current = false))}
        onDragEnd={(e: DragEndEvent) => {
          setTimeout(() => (dragged.current = false))
          if (e.over && e.active.id !== e.over.id) move(String(e.active.id), String(e.over.id))
        }}
      >
        <SortableContext items={shown.map((f) => f.path)} strategy={horizontalListSortingStrategy}>
          {shown.map((f) => {
            const w = labels(f)
            return <Chip key={f.path} id={f.path} leaving={!!f.leaving} icon={w.icon} name={w.name} sub={w.sub} onOpen={() => !dragged.current && w.open()} onClose={() => !dragged.current && remove(f.path)} />
          })}
        </SortableContext>
      </DndContext>
      {rest.length > 0 && <MinimizedMenu folders={rest} remove={remove} more />}
    </div>
  )
}

function Chip({ id, leaving, icon, name, sub, onOpen, onClose }: { id: string; leaving: boolean; icon: ReactNode; name: string; sub: string; onOpen: () => void; onClose: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: leaving })
  return (
    <span
      ref={setNodeRef}
      className={`fmin__chip${leaving ? ' is-leaving' : ''}${isDragging ? ' is-dragging' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
    >
      <button className="fmin__open" onClick={onOpen} data-tip={sub}>
        {icon}
        <span className="truncate">{name}</span>
      </button>
      <button className="fmin__close" aria-label={`Close ${name}`} data-tip="Close" onClick={onClose}>
        <LuX />
      </button>
    </span>
  )
}

/**
 * The list, plus the ones just removed (marked `leaving`) for as long as their way out takes. Worked out while
 * rendering (not after), so a chip never vanishes for a frame before it starts to shrink away.
 */
function useLeaving(list: MinimizedFolder[], ms = 200): (MinimizedFolder & { leaving?: boolean })[] {
  const prev = useRef(list)
  const gone = useRef(new Map<string, { f: MinimizedFolder; until: number; at: number }>())
  const [, tick] = useState(0)
  const now = Date.now()
  const present = new Set(list.map((f) => f.path))
  prev.current.forEach((f, at) => {
    if (!present.has(f.path) && !gone.current.has(f.path)) gone.current.set(f.path, { f, until: now + ms, at })
  })
  for (const [path, g] of gone.current) if (present.has(path) || g.until <= now) gone.current.delete(path)
  // once the last one is out of the way, draw again without it
  const next = Math.min(...[...gone.current.values()].map((g) => g.until))
  useEffect(() => {
    if (!Number.isFinite(next)) return
    const t = setTimeout(() => tick((n) => n + 1), Math.max(0, next - Date.now()) + 10)
    return () => clearTimeout(t)
  }, [next])
  // each one leaving keeps its place among the others (no jump to the end before it goes)
  const out: (MinimizedFolder & { leaving?: boolean })[] = [...list]
  for (const g of [...gone.current.values()].sort((a, b) => a.at - b.at)) out.splice(Math.min(g.at, out.length), 0, { ...g.f, leaving: true })
  // the list as drawn is what a later removal is measured against
  prev.current = out.filter((f) => !f.leaving)
  return out
}

/** Chips shown at most (larger screens); past that, the last place is the "⋯" button. */
const MAX_CHIPS = 5

/** The list of minimized folders opening upwards from a button: the round one on the stage (phones), or "⋯" (`more`). */
function MinimizedMenu({ folders, remove, more }: { folders: MinimizedFolder[]; remove: (path: string) => void; more?: boolean }) {
  const [open, setOpen] = useState(false)
  const labels = useWindowLabels()
  const presence = usePresence(open, 140)
  const [pos, setPos] = useState({ bottom: 0, right: 12 })
  const button = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  // the stage mounts with the page: the button lives on it, like the menu button (ui/Navbar.tsx)
  const [stage, setStage] = useState<HTMLElement | null>(null)
  useEffect(() => setStage(document.querySelector<HTMLElement>('.stage')), [])

  useLayoutEffect(() => {
    if (!open || !button.current) return
    const r = button.current.getBoundingClientRect()
    setPos({ bottom: window.innerHeight - r.top + 8, right: Math.max(12, window.innerWidth - r.right) })
  }, [open])
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => !pop.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', away)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!more && !stage) return null
  const trigger = more ? (
    <button
      ref={button}
      className="fmin__more"
      aria-label={`${folders.length} more minimized folders`}
      aria-expanded={open}
      data-tip="More"
      onClick={() => setOpen((v) => !v)}
    >
      <LuEllipsis />
      <span className="fmin-fab__count">{folders.length}</span>
    </button>
  ) : null
  return (
    <>
      {trigger}
      {!more &&
        stage &&
        createPortal(
          <button ref={button} className="fmin-fab" aria-label={`Minimized folders: ${folders.length}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <LuFolders />
            <span className="fmin-fab__count">{folders.length}</span>
          </button>,
          stage,
        )}
      {presence.mounted &&
        createPortal(
          <div
            ref={pop}
            className={`popover fmin-menu nav-menu--up${presence.closing ? ' popover--closing' : ''}`}
            style={pos}
            role="dialog"
            aria-label="Minimized folders"
          >
            <span className="fmin-menu__title">Minimized</span>
            {folders.map((f) => {
              const w = labels(f)
              return (
                <span key={f.path} className="fmin-menu__row">
                  <button className="fmin-menu__open" onClick={() => (setOpen(false), w.open())}>
                    {w.icon}
                    <span className="fmin-menu__text">
                      <span className="truncate">{w.name}</span>
                      <span className="truncate muted">{w.sub}</span>
                    </span>
                  </button>
                  <button className="fmin__close" aria-label={`Close ${w.name}`} onClick={() => (folders.length === 1 && setOpen(false), remove(f.path))}>
                    <LuX />
                  </button>
                </span>
              )
            })}
          </div>,
          document.body,
        )}
    </>
  )
}
