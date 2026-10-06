import { useEffect } from 'react'
import { LuLockKeyholeOpen } from 'react-icons/lu'
import { useClock, useNow } from '../state/clock'
import { useOffice } from '../state/store'
import { checkUnlock, lockNow, useUnlock } from './TerminalLock'
import { chatTime } from './when'

// The navbar's padlock: shown while the authenticator code has the terminals and the Server window open on this device
// (ui/TerminalLock.tsx), with until when in its tip; a click locks them again at once.

/** Is the unlock on (and until when)? Asked on load, every half minute and when the page comes back. */
export function useUnlocked() {
  const live = useOffice((s) => s.source === 'live')
  const until = useUnlock((s) => s.until)
  const now = useNow(15_000).getTime()
  useEffect(() => {
    if (!live) return
    void checkUnlock()
    const t = setInterval(() => void checkUnlock(), 30_000)
    const back = () => document.visibilityState === 'visible' && void checkUnlock()
    document.addEventListener('visibilitychange', back)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', back)
    }
  }, [live])
  return live && !!until && until > now ? until : 0
}

export function UnlockButton() {
  const until = useUnlocked()
  const timezone = useClock((s) => s.timezone)
  if (!until) return null
  return (
    <button
      className="icon-btn icon-btn--badge unlock-btn"
      onClick={() => void lockNow()}
      data-tip={`Terminals & Server unlocked with your 2FA code on this device, until ${chatTime(until, timezone)} (longer while you use them). Click to lock them now.`}
      aria-label="Lock terminals and the Server window now"
    >
      <LuLockKeyholeOpen />
    </button>
  )
}
