import { useEffect, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { LuLoader, LuLockKeyhole, LuSquareTerminal } from 'react-icons/lu'
import { api } from '../state/auth'
import { CodeInput } from './TwoFactor'

// Terminals are keys straight into the server: the authenticator code typed just now opens them for this browser
// session, for a while after the last one was opened (the server checks it again for every connection).

/**
 * This browser session's unlock (the terminals and the Server window share it), as one value for the whole app: the
 * terminals, the Server window and the navbar's padlock all see the same thing. `until`: null not asked yet, 0 locked.
 */
export const useUnlock = create<{ until: number | null }>(() => ({ until: null }))

let checking: Promise<void> | null = null
/** Ask the server how long it's open (it extends with every use, so this moves on its own). */
export function checkUnlock() {
  if (!checking)
    checking = api('/api/terminal')
      .then((r) => (r.ok ? r.json() : { until: 0 }))
      .then((r: { until: number }) => useUnlock.setState({ until: r.until }))
      .catch(() => useUnlock.setState({ until: 0 }))
      .finally(() => (checking = null))
  return checking
}

/** Lock them again now: the code is asked for next time (shells still running keep running). */
export async function lockNow() {
  await api('/api/terminal/lock', { method: 'POST' }).catch(() => undefined)
  useUnlock.setState({ until: 0 })
}

/** Whether this session's terminals are open, and a way to open them with the code. */
export function useTerminalLock() {
  const until = useUnlock((s) => s.until)
  useEffect(() => void checkUnlock(), [])
  const unlock = async (code: string) => {
    const r = await api('/api/terminal/unlock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
    if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'That code didn’t work')
    useUnlock.setState({ until: ((await r.json()) as { until: number }).until })
  }
  return { open: until === null ? null : until > Date.now(), unlock, recheck: () => void checkUnlock(), relock: () => useUnlock.setState({ until: 0 }) }
}

/** The code form, then the terminal. `children` gets `onRefused`: the connection was turned away (the lock ran out). */
export function TerminalLock({
  hint,
  children,
  title = 'Terminal locked',
  action = 'Open terminal',
}: {
  hint: string
  children: (onRefused: () => void) => ReactNode
  /** what's locked (the Server window uses the same lock) */
  title?: string
  action?: string
}) {
  const lock = useTerminalLock()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (c = code) => {
    if (busy || c.length < 6) return
    setBusy(true)
    setError(null)
    try {
      await lock.unlock(c)
      setCode('')
    } catch (e) {
      setError((e as Error).message)
      setCode('')
    } finally {
      setBusy(false)
    }
  }
  if (lock.open === null)
    return (
      <div className="fterm__empty muted">
        <LuLoader className="spin" />
      </div>
    )
  if (lock.open) return <>{children(lock.relock)}</>
  return (
    <div className="fterm__empty tlock">
      <LuLockKeyhole className="fterm__icon" />
      <div className="fterm__title">{title}</div>
      <p className="muted fterm__hint">{hint} Enter the code from your authenticator app to open it.</p>
      <CodeInput value={code} onChange={setCode} onComplete={(v) => void submit(v)} autoFocus disabled={busy} />
      {error && <div className="row__error">{error}</div>}
      <button className="primary" onClick={() => void submit()} disabled={busy || code.length < 6}>
        {busy ? <LuLoader className="spin" /> : <LuSquareTerminal />} {action}
      </button>
    </div>
  )
}
