import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// A small menu of actions under a "⋯" button (a file in the file manager, a tag in the Tags tab), floating over the
// page and kept inside the screen. Closes on a pick, a click elsewhere, Esc or a resize.

export interface MenuAction {
  icon: ReactNode
  label: string
  danger?: boolean
  run: () => void
}

/** `x`/`y`: the point it opens from (usually the button's bottom right). */
export function ActionMenu({ x, y, title, actions, onClose }: { x: number; y: number; title?: string; actions: MenuAction[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  // kept inside the screen: opens to the left / above when there's no room
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    setPos({ left: Math.max(8, Math.min(x - (x + w > innerWidth - 8 ? w : 0), innerWidth - w - 8)), top: y + h > innerHeight - 8 ? Math.max(8, y - h) : y })
  }, [x, y])
  useEffect(() => {
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose())
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', key, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])
  return createPortal(
    <div ref={ref} className="fb-menu ui-pop" role="menu" style={pos ? { left: pos.left, top: pos.top } : { left: x, top: y, visibility: 'hidden' }}>
      {title && <div className="fb-menu__name truncate">{title}</div>}
      {actions.map((a) => (
        <button
          key={a.label}
          role="menuitem"
          className={a.danger ? 'is-danger' : ''}
          onClick={() => {
            onClose()
            a.run()
          }}
        >
          {a.icon} {a.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}
