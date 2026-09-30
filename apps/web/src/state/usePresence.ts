import { useEffect, useState } from 'react'

/**
 * Keep something mounted for `ms` after `open` turns false, so it can play a closing animation.
 * `mounted`: render it; `closing`: add the closing class.
 */
export function usePresence(open: boolean, ms = 160) {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)
  useEffect(() => {
    if (open) {
      setMounted(true)
      setClosing(false)
      return
    }
    if (!mounted) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    setClosing(true)
    const t = setTimeout(() => {
      setMounted(false)
      setClosing(false)
    }, reduced ? 0 : ms)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  return { mounted, closing }
}
