import { useEffect, useReducer, useRef } from 'react'
import { flip, offset, shift } from '@floating-ui/dom'
import { Tooltip, type TooltipRefProps } from 'react-tooltip'
import { useMediaQuery } from '../state/useMediaQuery'

// One tooltip for the whole app (react-tooltip). Any element with `data-tip="…"` gets it, including elements inside
// modals, the drawer and the date picker portal (the library watches the DOM).
// - Mouse / keyboard: on hover and focus.
// - Touch screens: only on a long press (a tap just does what the button does). Releasing after the tooltip showed
//   doesn't trigger the button, and the tooltip fades a moment later.
// A long tip can be hovered and scrolled (it stays open while the pointer is on it).
// Icon-only buttons should also carry an aria-label; `tip()` sets both.

// Above the element, or below it when there's no room above: never beside it (the library's default may flip a tip
// to the left or right, where it covers what's next to it).
const MIDDLEWARES = [offset(8), flip({ fallbackPlacements: ['bottom'], fallbackAxisSideDirection: 'none' }), shift({ padding: 8 })]

const HOLD_MS = 450
const MOVE_TOLERANCE = 10
const SHOW_AFTER_RELEASE_MS = 1500

/** The tip's text, with a bold heading on top when the element has `data-tip-title`. */
function tipContent(el: Element | null) {
  const text = el?.getAttribute('data-tip')
  if (!text) return null
  const title = el?.getAttribute('data-tip-title')
  return title ? (
    <>
      <strong className="ao-tip__title">{title}</strong>
      {text}
    </>
  ) : (
    text
  )
}

export function TooltipLayer() {
  const touch = useMediaQuery('(hover: none)')
  return touch ? <TouchTooltip /> : <HoverTooltip />
}

function HoverTooltip() {
  // a tip that changes while it's shown (a switch turned on under the pointer): shown again with the new words
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const seen = new MutationObserver(redraw)
    seen.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-tip', 'data-tip-title'] })
    return () => seen.disconnect()
  }, [])
  return (
    <Tooltip
      id="ao-tip"
      anchorSelect="[data-tip]"
      render={({ activeAnchor }) => tipContent(activeAnchor)}
      disableTooltip={(anchor) => !anchor?.getAttribute('data-tip')}
      className="ao-tip"
      classNameArrow="ao-tip__arrow"
      place="top"
      middlewares={MIDDLEWARES}
      delayShow={250}
      delayHide={120}
      clickable
      positionStrategy="fixed"
      opacity={1}
    />
  )
}

function TouchTooltip() {
  const ref = useRef<TooltipRefProps>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let hide: ReturnType<typeof setTimeout> | undefined
    let start: { x: number; y: number } | null = null
    let target: Element | null = null
    let shown = false
    /** the current press is the one that opened the tooltip: its release must not press the button */
    let pressOpened = false

    const clear = () => {
      clearTimeout(timer)
      timer = undefined
      start = null
    }
    const close = () => {
      ref.current?.close()
      document.querySelectorAll('[data-tip-active]').forEach((el) => el.removeAttribute('data-tip-active'))
      shown = false
    }

    const onStart = (e: TouchEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-tip]')
      clear()
      // any new touch dismisses an open tooltip, and does whatever it touches as usual
      pressOpened = false
      if (shown) {
        clearTimeout(hide)
        close()
      }
      if (!el?.getAttribute('data-tip')) return
      target = el
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      timer = setTimeout(() => {
        if (!target) return
        clearTimeout(hide)
        close()
        target.setAttribute('data-tip-active', '')
        ref.current?.open({ anchorSelect: '[data-tip-active]', content: target.getAttribute('data-tip') })
        shown = true
        pressOpened = true
      }, HOLD_MS)
    }
    const onMove = (e: TouchEvent) => {
      if (!start) return
      const t = e.touches[0]
      if (Math.abs(t.clientX - start.x) > MOVE_TOLERANCE || Math.abs(t.clientY - start.y) > MOVE_TOLERANCE) clear()
    }
    const onEnd = (e: TouchEvent) => {
      clear()
      if (!pressOpened) return
      pressOpened = false
      // this press was for the tooltip: don't press the button underneath
      if (e.cancelable) e.preventDefault()
      clearTimeout(hide)
      hide = setTimeout(close, SHOW_AFTER_RELEASE_MS)
    }
    // Android opens the context menu on a long press
    const onContext = (e: Event) => {
      if ((e.target as Element | null)?.closest?.('[data-tip]')) e.preventDefault()
    }
    const onScroll = () => {
      clear()
      pressOpened = false
      if (shown) close()
    }

    document.addEventListener('touchstart', onStart, { passive: true, capture: true })
    document.addEventListener('touchmove', onMove, { passive: true, capture: true })
    document.addEventListener('touchend', onEnd, { passive: false, capture: true })
    document.addEventListener('touchcancel', onScroll, { capture: true })
    document.addEventListener('contextmenu', onContext, { capture: true })
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      clear()
      clearTimeout(hide)
      close()
      document.removeEventListener('touchstart', onStart, { capture: true })
      document.removeEventListener('touchmove', onMove, { capture: true })
      document.removeEventListener('touchend', onEnd, { capture: true })
      document.removeEventListener('touchcancel', onScroll, { capture: true })
      document.removeEventListener('contextmenu', onContext, { capture: true })
      window.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [])

  return (
    <Tooltip
      ref={ref}
      id="ao-tip"
      imperativeModeOnly
      render={({ activeAnchor }) => tipContent(activeAnchor)}
      className="ao-tip"
      classNameArrow="ao-tip__arrow"
      place="top"
      middlewares={MIDDLEWARES}
      positionStrategy="fixed"
      opacity={1}
    />
  )
}

/** Props for an icon-only control: visible tooltip + accessible name. */
export const tip = (label: string) => ({ 'data-tip': label, 'aria-label': label })
