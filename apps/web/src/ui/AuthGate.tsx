import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { LuEye, LuEyeOff, LuLoader } from 'react-icons/lu'
import { useAuth } from '../state/auth'
import { useDaylight } from '../state/clock'
import { tip } from './Tooltip'
import { Brand } from './Brand'
import { CodeStep, SetupPage } from './TwoFactor'

/** Keeps <html data-theme> in sync with the office clock, on the login page as well as the dashboard. */
function useThemeSync() {
  const daylight = useDaylight()
  useEffect(() => {
    document.documentElement.dataset.theme = daylight < 0.5 ? 'night' : 'day'
  }, [daylight])
}

/** Nothing below renders (or fetches) until the server confirms a session. */
export function AuthGate({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status)
  const check = useAuth((s) => s.check)
  useThemeSync()

  useEffect(() => {
    check()
  }, [check])

  if (status === 'checking')
    return (
      <div className="auth-splash">
        <LuLoader className="spin" />
      </div>
    )
  if (status === 'signed-out') return <LoginPage />
  if (status === 'needs-code') return <CodeStep />
  if (status === 'setup-2fa') return <SetupPage />
  return <>{children}</>
}

function LoginPage() {
  const login = useAuth((s) => s.login)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !password || busy) return
    setBusy(true)
    setError('')
    const err = await login(username.trim(), password, remember)
    setBusy(false)
    if (err) {
      setError(err)
      setPassword('')
    }
  }

  return (
    <main className="auth">
      <form className="auth__card" onSubmit={submit} noValidate>
        <div className="auth__brand">
          <Brand sub="Sign in to your workspace" />
        </div>

        <label className="field">
          <span className="field__label">Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
        </label>
        <label className="field">
          <span className="field__label">Password</span>
          <span className="auth__pw">
            <input
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            <button type="button" className="icon-btn small ghost" onClick={() => setShow((v) => !v)} {...tip(show ? 'Hide password' : 'Show password')}>
              {show ? <LuEyeOff /> : <LuEye />}
            </button>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Keep me signed in for 30 days
        </label>

        {error && (
          <p className="auth__error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="primary auth__submit" disabled={busy || !username.trim() || !password}>
          {busy ? <LuLoader className="spin" /> : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
