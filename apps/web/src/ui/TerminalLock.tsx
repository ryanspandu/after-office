import { useEffect, useState, type ReactNode } from 'react'
import { LuLoader, LuLockKeyhole, LuSquareTerminal } from 'react-icons/lu'
import { api } from '../state/auth'
import { CodeInput } from './TwoFactor'

// Terminals are keys straight into the server: the authenticator code typed just now opens them for this browser
// session, for a while after the last one was opened (the server checks it again for every connection).

/** Whether this session's terminals are open, and a way to open them with the code. */
export function useTerminalLock() {
  const [until, setUntil] = useState<number | null>(null)
  const check = () =>
    void api('/api/terminal')
      .then((r) => (r.ok ? r.json() : { until: 0 }))
      .then((r: { until: number }) => setUntil(r.until))
      .catch(() => setUntil(0))
  useEffect(check, [])
  const unlock = async (code: string) => {
    const r = await api('/api/terminal/unlock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
    if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'That code didn’t work')
    setUntil(((await r.json()) as { until: number }).until)
  }
  return { open: until === null ? null : until > Date.now(), unlock, recheck: check, relock: () => setUntil(0) }
}

/** The code form, then the terminal. `children` gets `onRefused`: the connection was turned away (the lock ran out). */
export function TerminalLock({ hint, children }: { hint: string; children: (onRefused: () => void) => ReactNode }) {
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
      <div className="fterm__title">Terminal locked</div>
      <p className="muted fterm__hint">{hint} Enter the code from your authenticator app to open it.</p>
      <CodeInput value={code} onChange={setCode} onComplete={(v) => void submit(v)} autoFocus disabled={busy} />
      {error && <div className="row__error">{error}</div>}
      <button className="primary" onClick={() => void submit()} disabled={busy || code.length < 6}>
        {busy ? <LuLoader className="spin" /> : <LuSquareTerminal />} Open terminal
      </button>
    </div>
  )
}
