import { useEffect, useState } from 'react'

/** Live `window.matchMedia` result, e.g. useMediaQuery('(max-width: 768px)'). */
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setMatches(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return matches
}

/** Phones: the agents list becomes a modal behind a floating button. Keep in sync with the phone breakpoint in src/styles/. */
export const MOBILE = '(max-width: 768px)'
