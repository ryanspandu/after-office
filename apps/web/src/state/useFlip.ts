import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * A list whose items move when it's re-ordered (FLIP): each child with `data-flip="<key>"` slides from where it was to
 * where it is now, instead of jumping. `order`: the keys in their order (when it changes, the list moved).
 */
export function useFlip<T extends HTMLElement>(list: RefObject<T | null>, order: string) {
  const last = useRef(new Map<string, number>())
  useLayoutEffect(() => {
    const el = list.current
    if (!el) return
    const items = [...el.querySelectorAll<HTMLElement>(':scope > [data-flip]')]
    const now = new Map(items.map((i) => [i.dataset.flip!, i.getBoundingClientRect().top]))
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!reduced)
      for (const i of items) {
        const before = last.current.get(i.dataset.flip!)
        const after = now.get(i.dataset.flip!)!
        if (before === undefined || Math.abs(before - after) < 1) continue
        i.animate([{ transform: `translateY(${before - after}px)` }, { transform: 'translateY(0)' }], { duration: 320, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
      }
    last.current = now
  }, [list, order])
}
