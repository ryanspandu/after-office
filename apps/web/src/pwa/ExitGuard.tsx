import { useEffect, useState } from 'react'
import { pushStep } from '../state/url'
import { MOBILE, useMediaQuery } from '../state/useMediaQuery'
import { confirm } from '../ui/Confirm'
import { isStandalone } from './install'

// The installed app on a phone: the Back gesture at its very bottom (nothing open to close) would leave the app. It
// asks first. A step of its own sits under everything else in the history (state/url.ts pushStep): Back reaching it
// asks; "Stay" puts it back. A page can't close an installed app by itself on every phone: when it can't, "Leave"
// takes the step away and says one more Back leaves.

export function ExitGuard() {
  const phone = useMediaQuery(MOBILE)
  const [hint, setHint] = useState(false)
  useEffect(() => {
    if (!phone || !isStandalone()) return
    let gone = false
    const guard = () => {
      pushStep(() => {
        if (gone) return
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
