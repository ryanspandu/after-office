import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { MOBILE } from './useMediaQuery'

/**
 * Phones: a bottom sheet (a modal or a chat drawer, styles/sheet.css) closes by dragging its grab handle or header
 * down. The card follows the finger; let go past a third of its height (or with a quick flick) and it closes,
 * otherwise it springs back. Spread `dragProps` on the handle and the header; `ref` goes on the card (or pass the
 * card's ref when it has one already).
 */
export function useSheetDrag<T extends HTMLElement>(onClose: () => void, cardRef?: RefObject<T | null>) {
  const own = useRef<T | null>(null)
  const ref = cardRef ?? own
  const drag = useRef<{ y: number; t: number; id: number } | null>(null)

  const start = (e: ReactPointerEvent) => {
    if (!window.matchMedia(MOBILE).matches || e.button !== 0) return
    // the header's own buttons, tabs and fields stay what they are
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea, [role="tab"]')) return
    drag.current = { y: e.clientY, t: performance.now(), id: e.pointerId }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    ref.current?.classList.add('is-dragging')
  }
  const move = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId || !ref.current) return
    const dy = Math.max(0, e.clientY - d.y)
    ref.current.style.transform = dy ? `translateY(${dy}px)` : ''
  }
  const end = (e: ReactPointerEvent) => {
    const d = drag.current
    const el = ref.current
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

  return { ref, dragProps: { onPointerDown: start, onPointerMove: move, onPointerUp: end, onPointerCancel: end } }
}
