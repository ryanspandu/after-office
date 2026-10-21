import { useEffect, useState } from 'react'
import { pushStep } from '../state/url'
import { MOBILE, useMediaQuery } from '../state/useMediaQuery'
import { confirm } from '../ui/Confirm'
import { isStandalone } from './install'

// The installed app on a phone: the Back gesture at its very bottom (nothing open to close) would leave the app. It
// asks first; with a window still open there (opened along with the app, from its address), Back closes that instead.
// A step of its own sits under everything else in the history (state/url.ts pushStep): Back reaching it asks; "Stay"
// puts it back. A page can't close an installed app by itself on every phone: when it can't, "Leave"
// takes the step away and says one more Back leaves.

/** A window, sheet or drawer that's open (shown, not minimized or on its way out), and its close button. */
const OPEN = '.modal-backdrop:not(.modal-backdrop--hidden):not(.modal-backdrop--closing), .drawer-backdrop:not(.drawer-backdrop--closing)'
const CLOSE = '.modal__head button[aria-label="Close"], .drawer button[aria-label="Close"], button[aria-label="Close"]'

export function ExitGuard() {
  const phone = useMediaQuery(MOBILE)
  const [hint, setHint] = useState(false)
  useEffect(() => {
    if (!phone || !isStandalone()) return
    let gone = false
    const guard = () => {
      pushStep(() => {
        if (gone) return
        // something is still open whose own Back step isn't there (opened along with the app, from its address):
        // Back closes it (its own close button), and the guard stays
        const open = [...document.querySelectorAll<HTMLElement>(OPEN)].pop()
        if (open) {
          guard()
          const close = open.querySelector<HTMLElement>(CLOSE)
          if (close) close.click()
          else window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
          return
        }
        void confirm({ title: 'Leave After Office?', message: 'The app closes. Your agents keep working on the server.', confirmLabel: 'Leave', danger: false }).then((leave) => {
          if (gone) return
          if (!leave) return guard()
          window.close()
          // still here (most phones keep an installed app open): the next Back leaves
          setTimeout(() => !gone && setHint(true), 300)
        })
      })
    }
    guard()
    return () => void (gone = true)
  }, [phone])
  useEffect(() => {
    if (!hint) return
    const t = setTimeout(() => setHint(false), 3000)
    return () => clearTimeout(t)
  }, [hint])
  return hint ? (
    <div className="exit-hint" role="status">
      Swipe back once more to leave
    </div>
  ) : null
}
