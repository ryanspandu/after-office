import { useEffect, useRef, useState, type ReactNode } from 'react'
import { LuChevronLeft, LuChevronRight } from 'react-icons/lu'

// A row of tabs that doesn't squeeze: it scrolls sideways when it doesn't fit. With a mouse, small arrow buttons at
// the ends scroll it (only while there's more that way); on touch screens it's swiped. The active tab is kept in view.

export function ScrollTabs({ children, className = '', label, active }: { children: ReactNode; className?: string; label: string; active?: string }) {
  const row = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  useEffect(() => {
    const el = row.current
    if (!el) return
    const measure = () => setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 })
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', measure)
      ro.disconnect()
    }
  }, [])
  // the picked tab comes into view when it changes (not on every render: that would undo the owner's scrolling, and
  // not on opening: the row starts at its left end)
  const shown = useRef(active)
  useEffect(() => {
    if (shown.current === active) return
    shown.current = active
    const row_ = row.current
    const tab = row_?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!row_ || !tab) return
    if (tab.offsetLeft < row_.scrollLeft) row_.scrollLeft = tab.offsetLeft - 4
    else if (tab.offsetLeft + tab.offsetWidth > row_.scrollLeft + row_.clientWidth) row_.scrollLeft = tab.offsetLeft + tab.offsetWidth - row_.clientWidth + 4
  }, [active])
  const by = (dir: 1 | -1) => row.current?.scrollBy({ left: dir * Math.max(80, (row.current?.clientWidth ?? 200) * 0.6), behavior: 'smooth' })
  return (
    <div className="scroll-tabs">
      {edges.left && (
        <button type="button" className="scroll-tabs__arrow scroll-tabs__arrow--left" aria-label="Scroll tabs left" tabIndex={-1} onClick={() => by(-1)}>
          <LuChevronLeft />
        </button>
      )}
      <div ref={row} className={`seg scroll-tabs__row ${className}`} role="tablist" aria-label={label}>
        {children}
      </div>
      {edges.right && (
        <button type="button" className="scroll-tabs__arrow scroll-tabs__arrow--right" aria-label="Scroll tabs right" tabIndex={-1} onClick={() => by(1)}>
          <LuChevronRight />
        </button>
      )}
    </div>
  )
}
