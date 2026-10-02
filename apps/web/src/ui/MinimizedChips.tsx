import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LuEllipsis, LuFolder, LuFolders, LuX } from 'react-icons/lu'
import { useMinimized, type MinimizedFolder } from '../state/minimized'
import { MOBILE, useMediaQuery } from '../state/useMediaQuery'
import { usePresence } from '../state/usePresence'
import { openUrl } from '../state/url'

const nameOf = (f: MinimizedFolder) => f.path.split('/').pop() || f.path
const tilde = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~')

/**
 * The minimized folder windows: a click opens one again as it was left, ✕ closes it for good. Larger screens: chips at
 * the bottom centre. Phones: one round button on the 3D stage, above the menu button (the dock, the menu and the app's
 * reload button keep their places), with the list opening upwards from it.
 */
export function MinimizedChips({ current }: { current?: string }) {
  const folders = useMinimized((s) => s.folders).filter((f) => f.path !== current)
  const remove = useMinimized((s) => s.remove)
  const mobile = useMediaQuery(MOBILE)
  if (!folders.length) return null
  if (mobile) return <MinimizedMenu folders={folders} remove={remove} />
  // many of them: the first few as chips, the rest behind "⋯" (with how many)
  const shown = folders.length > MAX_CHIPS ? folders.slice(0, MAX_CHIPS - 1) : folders
  const rest = folders.slice(shown.length)
  return (
    <div className="fmin" role="toolbar" aria-label="Minimized folders">
      {shown.map((f) => (
        <span key={f.path} className="fmin__chip">
          <button className="fmin__open" onClick={() => openUrl({ folder: f.path })} data-tip={tilde(f.path)}>
            <LuFolder />
            <span className="truncate">{nameOf(f)}</span>
          </button>
          <button className="fmin__close" aria-label={`Close ${nameOf(f)}`} data-tip="Close" onClick={() => remove(f.path)}>
            <LuX />
          </button>
        </span>
      ))}
      {rest.length > 0 && <MinimizedMenu folders={rest} remove={remove} more />}
    </div>
  )
}

/** Chips shown at most (larger screens); past that, the last place is the "⋯" button. */
const MAX_CHIPS = 5

/** The list of minimized folders opening upwards from a button: the round one on the stage (phones), or "⋯" (`more`). */
function MinimizedMenu({ folders, remove, more }: { folders: MinimizedFolder[]; remove: (path: string) => void; more?: boolean }) {
  const [open, setOpen] = useState(false)
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
            {folders.map((f) => (
              <span key={f.path} className="fmin-menu__row">
                <button className="fmin-menu__open" onClick={() => (setOpen(false), openUrl({ folder: f.path }))}>
                  <LuFolder />
                  <span className="fmin-menu__text">
                    <span className="truncate">{nameOf(f)}</span>
                    <span className="truncate muted">{tilde(f.path)}</span>
                  </span>
                </button>
                <button className="fmin__close" aria-label={`Close ${nameOf(f)}`} onClick={() => (folders.length === 1 && setOpen(false), remove(f.path))}>
                  <LuX />
                </button>
              </span>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}
