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
/** How far up a sheet must be pulled (of the way to full size) before letting go makes it full size. */
const GROW_AT = 0.4
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

export function useSheetDrag<T extends HTMLElement>(onClose: () => void, cardRef?: RefObject<T | null>, onShrink?: () => void, onGrow?: () => void) {
  const own = useRef<T | null>(null)
  const ref = cardRef ?? own
  const drag = useRef<{ y: number; t: number; id: number; moved?: boolean; armed?: boolean; h0?: number; hMax?: number; up?: number; hFull?: number; hSmall?: number } | null>(null)

  /** Full size, pulled down: the sheet shrinks under the finger to its usual size, then slides down after it. */
  const squeeze = (el: HTMLElement, d: NonNullable<typeof drag.current>, dy: number) => {
    if (d.hFull === undefined) {
      d.hFull = el.offsetHeight
      // its usual size: measured with full size off for a moment (same frame, nothing is painted)
      el.classList.remove('modal--full')
      d.hSmall = Math.min(d.hFull, el.offsetHeight)
      el.classList.add('modal--full')
      el.style.maxHeight = 'none'
    }
    const room = d.hFull - d.hSmall!
    const shrunk = Math.min(dy, room)
    el.style.height = `${d.hFull - shrunk}px`
    el.style.borderTopLeftRadius = el.style.borderTopRightRadius = `${room ? (22 * shrunk) / room : 22}px`
    el.style.transform = dy > room ? `translateY(${dy - room}px)` : ''
  }

  /** Pulling up: the sheet itself grows under the finger, its top corners squaring off on the way to full size. */
  const stretch = (el: HTMLElement, d: NonNullable<typeof drag.current>, up: number) => {
    const backdrop = el.parentElement
    if (d.h0 === undefined) {
      d.h0 = el.offsetHeight
      // room to grow into: the whole screen (the backdrop's top gap goes while pulling)
      if (backdrop) backdrop.style.paddingTop = '0px'
      d.hMax = backdrop?.clientHeight ?? window.innerHeight
      el.style.maxHeight = 'none'
    }
    const room = Math.max(1, d.hMax! - d.h0)
    // past full size it only gives a little
    const over = Math.max(0, up - room)
    const grown = Math.min(up, room) + over / 6
    el.style.height = `${d.h0 + grown}px`
    const p = Math.min(1, up / room)
    el.style.borderTopLeftRadius = el.style.borderTopRightRadius = `${22 * (1 - p)}px`
    d.up = up
    const armed = p >= GROW_AT
    if (armed && !d.armed) haptic()
    d.armed = armed
  }
  const unstretch = (el: HTMLElement) => {
    el.style.height = el.style.maxHeight = el.style.borderTopLeftRadius = el.style.borderTopRightRadius = ''
    if (el.parentElement) el.parentElement.style.paddingTop = ''
  }

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
    if (dy >= 0 && onShrink) return squeeze(ref.current, d, dy)
    if (dy >= 0) {
      if (d.h0 !== undefined) stretch(ref.current, d, 0)
      ref.current.style.transform = dy ? `translateY(${dy}px)` : ''
      return
    }
    ref.current.style.transform = ''
    stretch(ref.current, d, -dy)
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
    // pulled up: full size from where the finger left it (far enough, or a flick up), else back down to its size
    if (d.h0 !== undefined) {
      const now = el.offsetHeight
      const flick = (d.up ?? 0) > 40 && (d.up ?? 0) / Math.max(1, performance.now() - d.t) > 0.8
      unstretch(el)
      if (onGrow && (d.armed || flick) && e.type !== 'pointercancel') {
        if (!d.armed) haptic()
        el.dataset.fromHeight = String(now)
        onGrow()
        delete el.dataset.fromHeight
      } else if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.animate([{ height: `${now}px` }, { height: `${d.h0}px` }], { duration: 240, easing: EASE })
      }
      if (e.clientY - d.y <= 0) return
    }
    const dy = Math.max(0, e.clientY - d.y)
    const speed = dy / Math.max(1, performance.now() - d.t)
    if (onShrink && d.hFull !== undefined) {
      // nearly to the bottom: closed (it slides away from where it is)
      if (dy > d.hFull * 0.75) return haptic(), onClose()
      const now = el.offsetHeight
      const radius = el.style.borderTopLeftRadius
      unstretch(el)
      // a pull (or a flick) down: its usual size, on from where the finger left it
      if (dy > 60 || (dy > 30 && speed > 0.6)) {
        haptic()
        el.dataset.fromHeight = String(now)
        el.dataset.fromRadius = radius
        onShrink()
        delete el.dataset.fromHeight
        delete el.dataset.fromRadius
      } else if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.animate(
          [
            { height: `${now}px`, borderTopLeftRadius: radius, borderTopRightRadius: radius },
            { height: `${d.hFull}px`, borderTopLeftRadius: '0px', borderTopRightRadius: '0px' },
          ],
          { duration: 240, easing: EASE },
        )
      }
      settle()
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
