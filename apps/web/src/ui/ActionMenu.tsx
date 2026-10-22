import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { forgetStep, pushStep } from '../state/url'
import { MOBILE } from '../state/useMediaQuery'
import { useCloseOnListDrag } from './listDrag'

// A small menu of actions under a "⋯" button (a file in the file manager, a tag in the Tags tab), floating over the
// page and kept inside the screen; also the right-click / long-press menus (threads, folders, files). Closes on a pick,
// a click elsewhere (which does nothing else: useMenuDismiss), Esc, Back on a phone or a resize.

export interface MenuAction {
  icon: ReactNode
  label: string
  danger?: boolean
  run: () => void
}

/** `x`/`y`: the point it opens from (the button's bottom right: the menu's top right corner goes there; without
 *  `above`, the pointer of a right click: its top left corner goes there); `above`: the button's top, where it opens
 *  upward from when there's no room below (so it never covers its button); `width`: a set width (e.g. the column it opens in). */
export function ActionMenu({ x, y, above, width, title, actions, onClose, className = '' }: { x: number; y: number; above?: number; width?: number; title?: string; actions: MenuAction[]; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  // kept inside the screen: opens above when there's no room below
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    // under a button (`above` given): its right edge under the button's (it opens toward the left), rightward only
    // when there's no room on the left. At the pointer (a right click): rightward from it, leftward only without room
    const left = above === undefined ? (x + w <= innerWidth - 8 ? x : x - w) : x - w >= 8 ? x - w : x
    setPos({ left: Math.max(8, Math.min(left, innerWidth - w - 8)), top: y + h > innerHeight - 8 ? Math.max(8, (above ?? y) - h) : y })
  }, [x, y, above, width])
  const release = useMenuDismiss(ref, true, onClose)
  // held on past the long press: the row starts being dragged, the menu gives way
  useCloseOnListDrag(onClose)
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose())
    document.addEventListener('keydown', key, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])
  return createPortal(
    <div ref={ref} className={`fb-menu ui-pop ${className}`} role="menu" style={{ ...(pos ? { left: pos.left, top: pos.top } : { left: x, top: y, visibility: 'hidden' }), ...(width ? { width, minWidth: 0, maxWidth: 'calc(100vw - 16px)' } : null) }}>
      {title && <div className="fb-menu__name truncate">{title}</div>}
      {actions.map((a) => (
        <button
          key={a.label}
          role="menuitem"
          className={a.danger ? 'is-danger' : ''}
          onClick={() => {
            release()
            onClose()
            a.run()
          }}
        >
          {a.icon} {a.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}

/**
 * How an open menu lets go of the page around it. A tap (or click) elsewhere only closes it: that whole tap, down to
 * its click, never reaches what's under it (a row doesn't open, a sheet doesn't close). Phones: Back only closes it
 * too, as a step of its own (state/url.ts pushStep), not the sheet or window under it.
 * `open`: whether it shows. Returns `release`, called first when an item is picked: the step is gone before the item
 * opens or closes anything (what it asks of the address waits for that Back).
 */
export function useMenuDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  const close = useRef(onClose)
  close.current = onClose
  const step = useRef<string | null>(null)
  const forget = useRef<ReturnType<typeof setTimeout> | null>(null)
  const release = useCallback(() => {
    if (forget.current) clearTimeout(forget.current), (forget.current = null)
    if (step.current) forgetStep(step.current), (step.current = null)
  }, [])
  useEffect(() => {
    if (!open) return
    // remounted at once (React's dev check): the same step stays
    if (forget.current) clearTimeout(forget.current), (forget.current = null)
    else if (!step.current && window.matchMedia(MOBILE).matches)
      step.current = pushStep(() => {
        step.current = null
        close.current()
      })
    const away = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      swallowTap(e)
      release()
      close.current()
    }
    // before anything on the page (window, capture): what's under it never sees the tap
    window.addEventListener('pointerdown', away, true)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      // closed some other way (Esc, a resize, a scroll): its step goes quietly
      forget.current = setTimeout(() => {
        forget.current = null
        if (step.current) forgetStep(step.current), (step.current = null)
      }, 0)
    }
  }, [open, ref, release])
  return release
}

/** The tap that closed a menu: it and what follows it (up, the mouse's copies, the click) go nowhere. */
function swallowTap(down: PointerEvent) {
  down.preventDefault()
  down.stopImmediatePropagation()
  const kinds = ['pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'click', 'contextmenu'] as const
  let timer: ReturnType<typeof setTimeout> | null = null
  const done = () => {
    if (timer) clearTimeout(timer)
    for (const k of kinds) window.removeEventListener(k, eat, true)
    window.removeEventListener('pointercancel', lift, true)
    window.removeEventListener('pointerdown', done, true)
  }
  const eat = (e: Event) => {
    // touchstart only stopped: blocking it would block the page's scrolling
    if (e.type !== 'touchstart' && e.cancelable) e.preventDefault()
    e.stopImmediatePropagation()
    if (e.type === 'click') done()
    if (e.type === 'pointerup') lift()
  }
  // the finger is up: its click comes right away, if at all (not after a scroll)
  const lift = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(done, 400)
  }
  for (const k of kinds) window.addEventListener(k, eat, { capture: true, passive: false })
  window.addEventListener('pointercancel', lift, true)
  // the next tap is a new one: let it through
  setTimeout(() => window.addEventListener('pointerdown', done, true), 0)
  // never stuck (a finger held down for long)
  setTimeout(done, 5000)
}
