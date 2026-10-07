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

/**
 * A tap on the dimmed area around a modal or drawer: closes it (or minimizes it, for the ones that can be). On a phone
 * with the keyboard up, that first tap only puts the keyboard away (it's how people dismiss it), not the sheet.
 */
export const onBackdropTap = (fn: () => void) => (e: { target: EventTarget; currentTarget: EventTarget }) => {
  if (e.target !== e.currentTarget) return
  const typing = document.activeElement
  if (window.matchMedia(MOBILE).matches && (typing instanceof HTMLTextAreaElement || (typing instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'range'].includes(typing.type)))) {
    typing.blur()
    return
  }
  fn()
}
