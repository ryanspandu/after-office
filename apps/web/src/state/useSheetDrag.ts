import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { MOBILE } from './useMediaQuery'

/**
 * Phones: a bottom sheet (a modal or a chat drawer, styles/sheet.css) closes by dragging its grab handle or header
 * down. The card follows the finger; let go past a third of its height (or with a quick flick) and it closes,
 * otherwise it springs back. Spread `dragProps` on the handle and the header; `ref` goes on the card (or pass the
 * card's ref when it has one already).
 * `onShrink`: the sheet is at full size (maximized): a short pull brings it back to its usual size, and only a pull
 * nearly to the bottom closes it.
 */
export function useSheetDrag<T extends HTMLElement>(onClose: () => void, cardRef?: RefObject<T | null>, onShrink?: () => void) {
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
    const settle = () => {
      el.classList.add('is-settling')
      el.style.transform = ''
      setTimeout(() => el.classList.remove('is-settling'), 220)
    }
    if (onShrink) {
      if (dy > el.offsetHeight * 0.75) return onClose()
      // a pull (or a flick) down: back to the usual size, sliding into place while it shrinks
      if (dy > 60 || (dy > 30 && speed > 0.6)) settle(), onShrink()
      else settle()
      return
    }
    if (dy > el.offsetHeight / 3 || (dy > 40 && speed > 0.6)) {
      onClose()
      return
    }
    settle()
  }

  return { ref, dragProps: { onPointerDown: start, onPointerMove: move, onPointerUp: end, onPointerCancel: end } }
}
