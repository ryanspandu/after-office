import { useEffect, useRef, useState } from 'react'
import { dropStep, forgetStep, pushStep } from '../state/url'
import { flushSync } from 'react-dom'
import { LuMaximize2, LuMinimize2 } from 'react-icons/lu'
import { MOBILE, useMediaQuery } from '../state/useMediaQuery'

// Full-width panels (desktop): the manager's and the agents' chat drawers can take the whole window. The choice is
// remembered per panel in this browser, and the switch animates the panel's width.

export function useMaximize(key: string) {
  const ref = useRef<HTMLElement>(null)
  const [full, setFull] = useState(() => {
    try {
      return localStorage.getItem(key) === '1'
    } catch {
      return false
    }
  })
  const toggle = () => {
    const el = ref.current
    const from = el?.getBoundingClientRect()
    flushSync(() => setFull((v) => !v))
    try {
      localStorage.setItem(key, full ? '0' : '1')
    } catch {
      /* this visit only */
    }
    if (!el || !from || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const to = el.getBoundingClientRect()
    el.animate([{ width: `${from.width}px` }, { width: `${to.width}px` }], { duration: 260, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
  }
  return { ref, full, toggle }
}

export function MaximizeButton({ full, onToggle }: { full: boolean; onToggle: () => void }) {
  // phones: the chat at full size (the sheet takes the screen), not a width
  const phone = useMediaQuery(MOBILE)
  const label = full ? 'Smaller' : phone ? 'Full size' : 'Full width'
  return (
    <button className="icon-btn small ghost maximize-btn" data-tip={label} aria-label={label} aria-pressed={full} onClick={onToggle}>
      {full ? <LuMinimize2 /> : <LuMaximize2 />}
    </button>
  )
}

/**
 * The same for a modal (file preview, report): its card grows to the whole window and back, width and height
 * animated. Put `bodyRef` on an element inside the modal; pass width / className / actions to <Modal>. Phones: the
 * bottom sheet takes the whole screen, and that's a step in the history: the Back gesture makes it smaller first, the
 * next one closes it. `remember`: a key to keep the choice in this browser (the dock's sheets).
 */
export function useModalMaximize(width: number, remember?: string) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [full, setFull] = useState(() => {
    try {
      return !!remember && localStorage.getItem(remember) === '1'
    } catch {
      return false
    }
  })
  // phones: full size is a step of its own (state/url.ts pushStep)
  const step = useRef<string | null>(null)
  const forget = useRef<ReturnType<typeof setTimeout> | null>(null)
  const phone = () => window.matchMedia('(max-width: 768px)').matches
  const flipRef = useRef(() => {})
  const enterStep = () => {
    step.current = pushStep(() => {
      step.current = null
      flipRef.current()
    })
  }
  // opened at full size (remembered): the step from the start
  useEffect(() => {
    // remounted at once (React's dev check): the same step stays
    if (forget.current) clearTimeout(forget.current), (forget.current = null)
    else if (full && phone() && !step.current) enterStep()
    return () => {
      forget.current = setTimeout(() => {
        forget.current = null
        if (step.current) forgetStep(step.current), (step.current = null)
      }, 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const toggle = () => {
    // smaller with the button: the step goes back out (its Back makes it smaller)
    if (full && step.current) return dropStep(step.current)
    flip()
    if (!full && phone()) enterStep()
  }
  const flip = () => {
    if (remember)
      try {
        localStorage.setItem(remember, full ? '0' : '1')
      } catch {
        /* this visit only */
      }
    const card = bodyRef.current?.closest<HTMLElement>('.modal')
    const from = card?.getBoundingClientRect()
    // its own CSS transitions (e.g. the note window's width for Ask Marcus) off while measuring: the size it ends at
    if (card) card.style.transition = 'none'
    flushSync(() => setFull((v) => !v))
    const to = card?.getBoundingClientRect()
    if (card) requestAnimationFrame(() => (card.style.transition = ''))
    if (!card || !from || !to || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    // phones: pulled up by hand, it grows on from where the finger let go (useSheetDrag)
    const pulled = Number(card.dataset.fromHeight)
    const fromHeight = pulled || from.height
    card.animate(
      [
        { width: `${from.width}px`, height: `${fromHeight}px`, ...(pulled ? { borderTopLeftRadius: card.dataset.fromRadius || '0px', borderTopRightRadius: card.dataset.fromRadius || '0px' } : {}) },
        { width: `${to.width}px`, height: `${to.height}px` },
      ],
      { duration: 260, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    )
  }
  flipRef.current = flip
  return {
    bodyRef,
    full,
    modalProps: {
      width: full ? 100_000 : width,
      className: full ? 'modal--full' : undefined,
      onShrink: full ? toggle : undefined,
      onGrow: full ? undefined : toggle,
      actions: (
        <button className="icon-btn small ghost" data-tip={full ? 'Smaller' : 'Full size'} aria-label={full ? 'Smaller' : 'Full size'} onClick={toggle}>
          {full ? <LuMinimize2 /> : <LuMaximize2 />}
        </button>
      ),
    },
  }
}
