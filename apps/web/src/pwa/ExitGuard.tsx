import { useEffect, useState } from 'react'
import { forgetStep, pushStep } from '../state/url'
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
    // the guard's own step (one at a time), and a window being closed by it right now
    let id: string | null = null
    let closing = false
    const guard = () => {
      if (gone || id) return
      id = pushStep(() => {
        id = null
        if (gone) return
        // something is still open whose own Back step isn't there (opened along with the app, from its address):
        // Back closes it (its own close button). The guard comes back only once that's done: closing a window can
        // itself go Back, which would land on a guard put back at once and close again… over and over (a frozen app)
        const open = [...document.querySelectorAll<HTMLElement>(OPEN)].pop()
        if (open) {
          if (closing) return
          closing = true
          const close = open.querySelector<HTMLElement>(CLOSE)
          if (close) close.click()
          else window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
          setTimeout(() => {
            closing = false
            guard()
          }, 800)
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
    return () => {
      gone = true
      // its step goes with it (a remount must not stack a second guard)
      if (id) forgetStep(id)
      id = null
    }
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
