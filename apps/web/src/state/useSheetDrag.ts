import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { MOBILE } from './useMediaQuery'
import { haptic } from './haptic'

/**
 * Phones: a bottom sheet (a modal or a chat drawer, styles/sheet.css) is resized by dragging its grab handle or
 * header. Its top follows the finger, up or down, and stays where it's let go (its own height, `data-sheet-h`, until
 * it closes or goes full size). Let go high up (over halfway into the space above its usual top) and it goes full
 * size; only a pull nearly to the bottom closes it. Spread `dragProps` on the handle and the header; `ref` goes on
 * the card (or pass the card's ref when it has one already).
 * `onShrink`: the sheet is at full size (maximized): pulled down, it leaves full size at the height it's let go at.
 * `onGrow`: the sheet can go full size (without it, it only grows to its usual top).
 */
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
/** The least of it that stays on screen while pulled down (below that it slides away instead of shrinking). */
const MIN_H = 140
/** Let go below this much of the screen's height: it closes. */
const CLOSE_AT = 0.25
/** Let go past this much of the way from its usual top to the screen's top: full size. */
const GROW_AT = 0.5

type Drag = { y: number; t: number; id: number; moved?: boolean; h0?: number; hCap?: number; hScreen?: number; full?: boolean; wasFree?: boolean; grow?: boolean; close?: boolean }

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const isFull = (el: HTMLElement) => el.classList.contains('modal--full')

/** Its own height, kept until it goes full size another way (the maximize button): any change of full size drops it. */
const watched = new WeakSet<HTMLElement>()
function watchFull(el: HTMLElement) {
  if (watched.has(el)) return
  watched.add(el)
  let was = isFull(el)
  new MutationObserver(() => {
    const now = isFull(el)
    if (now === was) return
    was = now
    // a drag that left full size set the height it wants just before: that one stays
    if (el.dataset.sheetKeep) return void delete el.dataset.sheetKeep
    clearFree(el)
  }).observe(el, { attributes: true, attributeFilter: ['class'] })
}
function setFree(el: HTMLElement, h: number) {
  el.dataset.sheetH = String(Math.round(h))
  el.style.setProperty('--sheet-h', `${Math.round(h)}px`)
}
function clearFree(el: HTMLElement) {
  delete el.dataset.sheetH
  el.style.removeProperty('--sheet-h')
}

export function useSheetDrag<T extends HTMLElement>(onClose: () => void, cardRef?: RefObject<T | null>, onShrink?: () => void, onGrow?: () => void) {
  const own = useRef<T | null>(null)
  const ref = cardRef ?? own
  const drag = useRef<Drag | null>(null)

  /** Sizes it from: its height now, the tallest it gets without full size, and the whole screen. */
  const measure = (el: HTMLElement, d: Drag) => {
    d.full = isFull(el)
    d.h0 = el.offsetHeight
    // its usual top: the card's max height when not full (measured with full size off for a moment, nothing painted)
    // (its own height comes off while dragging: the finger sizes it now)
    d.wasFree = !!el.dataset.sheetH
    clearFree(el)
    if (d.full) el.classList.remove('modal--full')
    const cap = parseFloat(getComputedStyle(el).maxHeight)
    if (d.full) el.classList.add('modal--full')
    const backdrop = el.parentElement
    if (backdrop) backdrop.style.paddingTop = '0px'
    d.hScreen = backdrop?.clientHeight || window.innerHeight
    d.hCap = Math.min(Number.isFinite(cap) ? cap : d.hScreen - 24, d.hScreen)
    el.style.maxHeight = 'none'
  }

  /** The sheet as tall as `h` (its top under the finger): it squares off on the way to full size, slides away low. */
  const resize = (el: HTMLElement, d: Drag, h: number) => {
    const canFull = !!onGrow || d.full
    const top = canFull ? d.hScreen! : d.hCap!
    // past the top it only gives a little
    const shown = h > top ? top + (h - top) / 6 : h
    el.style.height = `${Math.max(MIN_H, shown)}px`
    el.style.transform = h < MIN_H ? `translateY(${MIN_H - h}px)` : ''
    const p = canFull && h > d.hCap! ? Math.min(1, (h - d.hCap!) / Math.max(1, d.hScreen! - d.hCap!)) : 0
    el.style.borderTopLeftRadius = el.style.borderTopRightRadius = `${22 * (1 - p)}px`
    // a tick when letting go would go full size, or close
    const grow = canFull && p >= GROW_AT
    const close = h < d.hScreen! * CLOSE_AT
    if ((grow && !d.grow) || (close && !d.close)) haptic()
    d.grow = grow
    d.close = close
  }
  const unresize = (el: HTMLElement) => {
    el.style.height = el.style.maxHeight = el.style.borderTopLeftRadius = el.style.borderTopRightRadius = el.style.transform = ''
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
    const el = ref.current
    if (!d || d.id !== e.pointerId || !el) return
    const dy = e.clientY - d.y
    // a tap isn't a drag: nothing moves until the finger really goes a little way
    if (!d.moved) {
      if (Math.abs(dy) < 6) return
      d.moved = true
      watchFull(el)
      // measured before 'is-dragging' (a chat drawer lets go of its top then, and would shrink to its content)
      measure(el, d)
      el.style.height = `${d.h0}px`
      // its opening slide is over for good: taking 'is-dragging' off later mustn't play it again
      el.classList.add('is-opened', 'is-dragging')
    }
    resize(el, d, d.h0! - dy)
  }
  const end = (e: ReactPointerEvent) => {
    const d = drag.current
    const el = ref.current
    if (!d || d.id !== e.pointerId || !el) return
    drag.current = null
    // just a tap on the handle or the header: nothing happens
    if (!d.moved) return
    el.classList.remove('is-dragging')
    const h = d.h0! - (e.clientY - d.y)
    const now = el.offsetHeight
    const radius = el.style.borderTopLeftRadius
    const cancelled = e.type === 'pointercancel'

    // nearly to the bottom: closed (it slides away from where it is)
    if (!cancelled && d.close) {
      haptic()
      onClose()
      return
    }
    unresize(el)
    const glide = (to: number) =>
      !reduced() &&
      el.animate(
        [
          { height: `${now}px`, borderTopLeftRadius: radius, borderTopRightRadius: radius },
          { height: `${to}px`, borderTopLeftRadius: isFull(el) ? '0px' : '22px', borderTopRightRadius: isFull(el) ? '0px' : '22px' },
        ],
        { duration: 240, easing: EASE },
      )

    // high up: full size (from where the finger left it)
    if (!cancelled && d.grow) {
      clearFree(el)
      if (d.full) return void glide(el.offsetHeight)
      el.dataset.fromHeight = String(now)
      el.dataset.fromRadius = radius
      onGrow?.()
      delete el.dataset.fromHeight
      delete el.dataset.fromRadius
      return
    }
    // anywhere else: it stays that tall (at most its usual top)
    const to = Math.round(Math.min(Math.max(h, MIN_H), d.hCap!))
    if (cancelled) {
      // the gesture was taken over (a scroll, the system): back to how it was
      if (d.full) return
      if (d.wasFree) setFree(el, d.h0!)
      return void glide(d.h0!)
    }
    setFree(el, to)
    if (d.full && onShrink) {
      // leaving full size: the maximize animation runs on from where the finger let go to this height
      el.dataset.sheetKeep = '1'
      el.dataset.fromHeight = String(now)
      el.dataset.fromRadius = radius
      onShrink()
      delete el.dataset.fromHeight
      delete el.dataset.fromRadius
      return
    }
    glide(to)
  }

  return { ref, dragProps: { onPointerDown: start, onPointerMove: move, onPointerUp: end, onPointerCancel: end } }
}
