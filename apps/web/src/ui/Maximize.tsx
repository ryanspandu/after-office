import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { LuMaximize2, LuMinimize2 } from 'react-icons/lu'

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
  return (
    <button className="icon-btn small ghost maximize-btn" data-tip={full ? 'Smaller' : 'Full width'} aria-label={full ? 'Smaller' : 'Full width'} aria-pressed={full} onClick={onToggle}>
      {full ? <LuMinimize2 /> : <LuMaximize2 />}
    </button>
  )
}

/**
 * The same for a modal (file preview, report): its card grows to the whole window and back, width and height
 * animated. Put `bodyRef` on an element inside the modal; pass width / className / actions to <Modal>. Phones: the
 * bottom sheet takes the whole screen. `remember`: a key to keep the choice in this browser (the dock's sheets).
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
  const toggle = () => {
    if (remember)
      try {
        localStorage.setItem(remember, full ? '0' : '1')
      } catch {
        /* this visit only */
      }
    const card = bodyRef.current?.closest<HTMLElement>('.modal')
    const from = card?.getBoundingClientRect()
    flushSync(() => setFull((v) => !v))
    if (!card || !from || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const to = card.getBoundingClientRect()
    card.animate(
      [
        { width: `${from.width}px`, height: `${from.height}px` },
        { width: `${to.width}px`, height: `${to.height}px` },
      ],
      { duration: 260, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    )
  }
  return {
    bodyRef,
    full,
    modalProps: {
      width: full ? 100_000 : width,
      className: full ? 'modal--full' : undefined,
      onShrink: full ? toggle : undefined,
      actions: (
        <button className="icon-btn small ghost" data-tip={full ? 'Smaller' : 'Full size'} aria-label={full ? 'Smaller' : 'Full size'} onClick={toggle}>
          {full ? <LuMinimize2 /> : <LuMaximize2 />}
        </button>
      ),
    },
  }
}
