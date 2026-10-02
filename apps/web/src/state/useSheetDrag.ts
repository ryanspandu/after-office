import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { MOBILE } from './useMediaQuery'
import { haptic } from './haptic'

/**
 * Phones: a bottom sheet (a modal or a chat drawer, styles/sheet.css) closes by dragging its grab handle or header
 * down. The card follows the finger; let go past a third of its height (or with a quick flick) and it closes,
 * otherwise it springs back. Spread `dragProps` on the handle and the header; `ref` goes on the card (or pass the
 * card's ref when it has one already).
 * `onShrink`: the sheet is at full size (maximized): a short pull brings it back to its usual size, and only a pull
 * nearly to the bottom closes it.
 * `onGrow`: the sheet can go full size: a long pull up (not a nudge) does it.
 */
/** How far up the finger goes before a sheet grows to full size: a deliberate pull, not a nudge. */
const growDistance = () => Math.max(120, window.innerHeight * 0.18)

export function useSheetDrag<T extends HTMLElement>(onClose: () => void, cardRef?: RefObject<T | null>, onShrink?: () => void, onGrow?: () => void) {
  const own = useRef<T | null>(null)
  const ref = cardRef ?? own
  const drag = useRef<{ y: number; t: number; id: number; moved?: boolean; armed?: boolean } | null>(null)

  const start = (e: ReactPointerEvent) => {
    if (!window.matchMedia(MOBILE).matches || e.button !== 0) return
    // the header's own buttons, tabs and fields stay what they are
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea, [role="tab"]')) return
    drag.current = { y: e.clientY, t: performance.now(), id: e.pointerId }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const move = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId || !ref.current) return
    // down: positive; up only counts when the sheet can grow
    const dy = Math.max(onGrow ? -Infinity : 0, e.clientY - d.y)
    // a tap isn't a drag: nothing moves until the finger really goes a little way
    if (!d.moved) {
      if (Math.abs(dy) < 6) return
      d.moved = true
      // its opening slide is over for good: taking 'is-dragging' off later mustn't play it again
      ref.current.classList.add('is-opened')
      ref.current.classList.add('is-dragging')
    }
    if (dy >= 0) {
      ref.current.style.transform = dy ? `translateY(${dy}px)` : ''
      return
    }
    // up: the sheet only gives a little (it's anchored at the bottom); far enough and it will grow (one buzz)
    const up = -dy
    ref.current.style.transform = `translateY(${-Math.min(36, up / 4)}px)`
    const armed = up >= growDistance()
    if (armed && !d.armed) haptic()
    d.armed = armed
  }
  const end = (e: ReactPointerEvent) => {
    const d = drag.current
    const el = ref.current
    if (!d || d.id !== e.pointerId || !el) return
    drag.current = null
    // just a tap on the handle or the header: nothing happens
    if (!d.moved) return
    el.classList.remove('is-dragging')
    const settle = () => {
      el.classList.add('is-settling')
      el.style.transform = ''
      setTimeout(() => el.classList.remove('is-settling'), 220)
    }
    // pulled up far enough: full size
    if (onGrow && e.clientY - d.y <= -growDistance() && e.type !== 'pointercancel') {
      settle()
      onGrow()
      return
    }
    const dy = Math.max(0, e.clientY - d.y)
    const speed = dy / Math.max(1, performance.now() - d.t)
    if (onShrink) {
      if (dy > el.offsetHeight * 0.75) return haptic(), onClose()
      // a pull (or a flick) down: back to the usual size, sliding into place while it shrinks
      if (dy > 60 || (dy > 30 && speed > 0.6)) settle(), haptic(), onShrink()
      else settle()
      return
    }
    if (dy > el.offsetHeight / 3 || (dy > 40 && speed > 0.6)) {
      haptic()
      onClose()
      return
    }
    settle()
  }

  return { ref, dragProps: { onPointerDown: start, onPointerMove: move, onPointerUp: end, onPointerCancel: end } }
}
