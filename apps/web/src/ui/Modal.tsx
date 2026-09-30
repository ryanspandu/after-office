import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { usePresence } from '../state/usePresence'
import { MOBILE } from '../state/useMediaQuery'
import { LuX } from 'react-icons/lu'

interface Props {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  children: ReactNode
  width?: number
  /** extra class on the card, e.g. modal--full */
  className?: string
  /** buttons in the header, before the close button */
  actions?: ReactNode
}

export function Modal({ open, title, description, onClose, children, width = 460, className, actions }: Props) {
  const backdrop = useRef<HTMLDivElement | null>(null)
  const shownAt = useRef(0)
  const setBackdrop = useCallback((el: HTMLDivElement | null) => {
    if (el && el !== backdrop.current) shownAt.current = performance.now()
    if (el) backdrop.current = el
  }, [])
  // Most modals are closed by removing them (`{open && <Modal open …/>}`), which gives `open` no chance to animate
  // out. So when the modal goes away while still shown, a copy of it stays on the page just long enough to play the
  // closing animation (it can't be clicked, and it's gone after 180 ms).
  useLayoutEffect(
    () => () => {
      const el = backdrop.current
      if (!el?.isConnected || el.classList.contains('modal-backdrop--closing')) return
      // React's development double mount (StrictMode) removes it right after it appeared: nothing to animate
      if (performance.now() - shownAt.current < 100) return
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      const ghost = el.cloneNode(true) as HTMLElement
      ghost.classList.add('modal-backdrop--closing')
      ghost.setAttribute('aria-hidden', 'true')
      ghost.removeAttribute('id')
      ghost.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'))
      document.body.appendChild(ghost)
      setTimeout(() => ghost.remove(), 200)
    },
    [],
  )
  useEffect(() => {
    if (!open) return
    // with modals stacked (a confirmation over a task), Esc closes only the one on top
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const all = document.querySelectorAll('.modal-backdrop:not(.modal-backdrop--closing)')
      if (backdrop.current && all[all.length - 1] !== backdrop.current) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // the footer (buttons) is sticky at the bottom of the scrolling area: the scrollbar track stops above it
  const scrollRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    const measure = () => {
      const foot = scroll.querySelector<HTMLElement>(':scope > .modal__body > .modal__foot, :scope > form > .modal__foot, :scope .modal__body > .modal__foot')
      scroll.style.setProperty('--foot-h', `${foot ? foot.offsetHeight : 0}px`)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(scroll)
    const foot = scroll.querySelector<HTMLElement>('.modal__foot')
    if (foot) ro.observe(foot)
    return () => ro.disconnect()
  })

  // phones: a bottom sheet (styles/sheet.css). Dragging the handle or the header down follows the finger; let go past
  // a third of its height (or with a quick flick) and it closes, otherwise it springs back.
  const card = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; t: number; id: number } | null>(null)
  const onDragStart = (e: React.PointerEvent) => {
    if (!window.matchMedia(MOBILE).matches || e.button !== 0) return
    // the header's own buttons stay buttons
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) return
    drag.current = { y: e.clientY, t: performance.now(), id: e.pointerId }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    card.current?.classList.add('is-dragging')
  }
  const onDragMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId || !card.current) return
    const dy = Math.max(0, e.clientY - d.y)
    card.current.style.transform = dy ? `translateY(${dy}px)` : ''
  }
  const onDragEnd = (e: React.PointerEvent) => {
    const d = drag.current
    const el = card.current
    if (!d || d.id !== e.pointerId || !el) return
    drag.current = null
    el.classList.remove('is-dragging')
    const dy = Math.max(0, e.clientY - d.y)
    const speed = dy / Math.max(1, performance.now() - d.t)
    if (dy > el.offsetHeight / 3 || (dy > 40 && speed > 0.6)) {
      onClose()
      return
    }
    el.classList.add('is-settling')
    el.style.transform = ''
    setTimeout(() => el.classList.remove('is-settling'), 220)
  }
  const dragProps = { onPointerDown: onDragStart, onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd }

  // stays mounted briefly after closing so it can animate out
  const { mounted, closing } = usePresence(open, 180)
  if (!mounted) return null
  return createPortal(
    <div ref={setBackdrop} className={`modal-backdrop${closing ? ' modal-backdrop--closing' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={card} className={`modal${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={title} style={{ width: `min(${width}px, 100%)` }}>
        {/* phones: the grab handle of the bottom sheet (hidden on larger screens) */}
        <div className="modal__grab" aria-hidden="true" {...dragProps} />
        <header className="modal__head" {...dragProps}>
          <div>
            <h3>{title}</h3>
            {description && <p className="muted">{description}</p>}
          </div>
          <span className="modal__actions">
            {actions}
            <button className="icon-btn small ghost" data-tip="Close" aria-label="Close" onClick={onClose}>
              <LuX />
            </button>
          </span>
        </header>
        {/* the body scrolls, not the card: the header stays put and the scrollbar stays inside the rounded card */}
        <div className="modal__scroll" ref={scrollRef}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Labeled form field. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  )
}
