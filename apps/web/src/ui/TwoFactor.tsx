import { useEffect, useRef, useState, type FormEvent } from 'react'
import QRCode from 'qrcode'
import { LuCheck, LuCopy, LuDownload, LuKeyRound, LuLoader, LuLogOut, LuShieldCheck, LuSmartphone } from 'react-icons/lu'
import { api, useAuth } from '../state/auth'
import { useBranding } from '../state/branding'
import { Brand } from './Brand'
import { Modal } from './Modal'

// Two-factor sign-in with an authenticator app (Google Authenticator and the like): the code step after the password,
// the setup the first sign-in requires, the recovery codes, and Profile → Two-factor (new phone, new recovery codes).

/** The 6-digit code: numbers only, filled by the phone's "one-time code" suggestion, sent as soon as it's complete. */
export function CodeInput({ value, onChange, onComplete, autoFocus, disabled }: { value: string; onChange: (v: string) => void; onComplete?: (v: string) => void; autoFocus?: boolean; disabled?: boolean }) {
  return (
    <input
      className="code-input"
      value={value}
      onChange={(e) => {
        const v = e.target.value.replace(/\D/g, '').slice(0, 6)
        onChange(v)
        if (v.length === 6 && v !== value) onComplete?.(v)
      }}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      maxLength={6}
      placeholder="123456"
      aria-label="6-digit code"
      autoFocus={autoFocus}
      disabled={disabled}
    />
  )
}

/** Sign-in, step 2: the code from the app (or a recovery code). */
export function CodeStep() {
  const submitCode = useAuth((s) => s.submitCode)
  const restart = useAuth((s) => s.restart)
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState('')
  const [useRecovery, setUseRecovery] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const send = async (input: { code?: string; recovery?: string }) => {
    if (busy) return
    setBusy(true)
    setError('')
    const err = await submitCode(input)
    setBusy(false)
    if (err) {
      setError(err)
      setCode('')
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (useRecovery ? recovery.trim() : code.length === 6) void send(useRecovery ? { recovery: recovery.trim() } : { code })
  }

  return (
    <main className="auth">
      <form className="auth__card" onSubmit={submit} noValidate>
        <div className="auth__brand">
          <Brand sub="Two-factor sign-in" />
        </div>
        {useRecovery ? (
          <label className="field">
            <span className="field__label">Recovery code</span>
            <input value={recovery} onChange={(e) => setRecovery(e.target.value)} placeholder="abcd-efgh-ijkl" autoComplete="off" autoFocus spellCheck={false} />
            <span className="field__hint">One of the codes you saved when you set up two-factor. Each works once.</span>
          </label>
        ) : (
          <label className="field">
            <span className="field__label">Code from your authenticator app</span>
            <CodeInput value={code} onChange={setCode} onComplete={(v) => void send({ code: v })} autoFocus disabled={busy} />
          </label>
        )}
        {error && (
          <p className="auth__error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary auth__submit" disabled={busy || (useRecovery ? !recovery.trim() : code.length !== 6)}>
          {busy ? <LuLoader className="spin" /> : 'Verify'}
        </button>
        <div className="auth__links">
          <button type="button" className="link" onClick={() => (setUseRecovery((v) => !v), setError(''))}>
            {useRecovery ? 'Use the app code' : 'Lost your phone? Use a recovery code'}
          </button>
          <button type="button" className="link" onClick={restart}>
            Back
          </button>
        </div>
      </form>
    </main>
  )
}

/** A QR code (SVG) for an otpauth:// link. */
function Qr({ text }: { text: string }) {
  const [svg, setSvg] = useState('')
  useEffect(() => {
    let alive = true
    QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#ffffff' } })
      .then((s) => alive && setSvg(s))
      .catch(() => setSvg(''))
    return () => {
      alive = false
    }
  }, [text])
  return svg ? <div className="tfa-qr" role="img" aria-label="QR code to scan with your authenticator app" dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="tfa-qr tfa-qr--empty" />
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1600)
        } catch {
          // the text is on screen to copy by hand
        }
      }}
    >
      {done ? <LuCheck /> : <LuCopy />} {done ? 'Copied' : label}
    </button>
  )
}

type Setup = { secret: string; otpauthUrl: string }

/**
 * Scan the QR code, type the first code: two-factor is on. `start` asks the server for the secret (setup, or reset for a
 * new phone); then the recovery codes.
 */
function SetupSteps({ start, onDone }: { start: () => Promise<Setup>; onDone: () => void }) {
  const [setup, setSetup] = useState<Setup | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [codes, setCodes] = useState<string[] | null>(null)
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    start()
      .then(setSetup)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not start'))
  }, [start])

  const enable = async (v = code) => {
    if (busy || v.length !== 6) return
    setBusy(true)
    setError('')
    try {
      const r = await api('/api/auth/2fa/enable', { method: 'POST', body: JSON.stringify({ code: v }) })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error ?? 'Could not turn it on')
      setCodes(body.recoveryCodes as string[])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not turn it on')
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  if (codes) return <RecoveryCodes codes={codes} onDone={onDone} />
  return (
    <div className="tfa">
      <ol className="tfa__steps">
        <li>
          <b>Install an authenticator app</b> on your phone: <i>Google Authenticator</i> (or 1Password, Authy…).
        </li>
        <li>
          <b>Scan this QR code</b> with it (+ → Scan a QR code).
          <div className="tfa__qr-row">
            {setup ? <Qr text={setup.otpauthUrl} /> : <div className="tfa-qr tfa-qr--empty">{error ? '' : <LuLoader className="spin" />}</div>}
            {setup && (
              <div className="tfa__manual">
                {/* on the phone itself there's nothing to scan: the link opens the authenticator app with it */}
                <a className="tfa__open" href={setup.otpauthUrl}>
                  <LuSmartphone /> Open in authenticator app
                </a>
                <span className="muted">Can't scan? Enter this key in the app:</span>
                <code className="tfa__secret">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
                <CopyButton text={setup.secret} label="Copy key" />
              </div>
            )}
          </div>
        </li>
        <li>
          <b>Enter the 6-digit code</b> the app shows:
          <form
            className="tfa__code"
            onSubmit={(e) => {
              e.preventDefault()
              void enable()
            }}
          >
            <CodeInput value={code} onChange={setCode} onComplete={(v) => void enable(v)} disabled={!setup || busy} autoFocus />
            <button className="primary" disabled={!setup || busy || code.length !== 6}>
              {busy ? <LuLoader className="spin" /> : 'Turn on'}
            </button>
          </form>
        </li>
      </ol>
      {error && (
        <p className="auth__error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** The recovery codes, shown once: saved (copied or downloaded) before going on. */
export function RecoveryCodes({ codes, onDone, doneLabel = 'Continue' }: { codes: string[]; onDone: () => void; doneLabel?: string }) {
  const [saved, setSaved] = useState(false)
  const brand = useBranding((s) => s.name)
  const text = codes.join('\n')
  const download = () => {
    const blob = new Blob([`${brand} recovery codes (each works once)\n\n${text}\n`], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${brand.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-recovery-codes.txt`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  return (
    <div className="tfa">
      <p className="tfa__lead">
        <LuShieldCheck />
        <span>
          Two-factor is on. Save these <b>recovery codes</b>: if you lose your phone, each one signs you in once. They won't be shown again.
        </span>
      </p>
      <ul className="tfa__codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ul>
      <div className="tfa__actions">
        <CopyButton text={text} label="Copy all" />
        <button type="button" className="small" onClick={download}>
          <LuDownload /> Download .txt
        </button>
      </div>
      <label className="check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I saved them somewhere safe (a password manager)
      </label>
      <button className="primary" disabled={!saved} onClick={onDone}>
        {doneLabel}
      </button>
    </div>
  )
}

async function postSetup(path: string, body: object = {}): Promise<Setup> {
  const r = await api(path, { method: 'POST', body: JSON.stringify(body) })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error ?? `Request failed (${r.status})`)
  return data as Setup
}
const startFirstSetup = () => postSetup('/api/auth/2fa/setup')

/** After the password, while two-factor isn't set up: the only thing this session may do. */
export function SetupPage() {
  const check = useAuth((s) => s.check)
  const logout = useAuth((s) => s.logout)
  return (
    <main className="auth">
      <div className="auth__card auth__card--wide">
        <div className="auth__brand">
          <Brand sub="Set up two-factor sign-in" />
        </div>
        <p className="muted tfa__why">Required for this office: every sign-in asks for a code from your phone as well as your password.</p>
        <SetupSteps start={startFirstSetup} onDone={() => void check()} />
        <div className="auth__links">
          <button type="button" className="link" onClick={() => void logout()}>
            <LuLogOut /> Sign out
          </button>
        </div>
      </div>
    </main>
  )
}

/** Profile → Two-factor: status, a new phone, new recovery codes. Both need the current code. */
export function TwoFactorModal({ onClose }: { onClose: () => void }) {
  const info = useAuth((s) => s.twoFactor)
  const check = useAuth((s) => s.check)
  const [step, setStep] = useState<'home' | 'code-phone' | 'code-recovery' | 'phone' | 'recovery'>('home')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [codes, setCodes] = useState<string[]>([])
  const [setup, setSetup] = useState<Setup | null>(null)
  useEffect(() => {
    void check()
  }, [check])

  const withCode = async (v = code) => {
    if (busy || v.length !== 6) return
    setBusy(true)
    setError('')
    try {
      if (step === 'code-phone') {
        setSetup(await postSetup('/api/auth/2fa/reset', { code: v }))
        setStep('phone')
      } else {
        const r = await api('/api/auth/2fa/recovery', { method: 'POST', body: JSON.stringify({ code: v }) })
        const body = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(body.error ?? 'Could not make new codes')
        setCodes(body.recoveryCodes)
        setStep('recovery')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
      setCode('')
    } finally {
      setBusy(false)
    }
  }
  const finish = () => {
    void check()
    onClose()
  }

  return (
    <Modal open onClose={onClose} title="Two-factor sign-in" description="A code from your phone on every sign-in." width={480}>
      <div className="modal__body tfa-modal">
        {step === 'home' && (
          <>
            <p className="tfa__status">
              <LuShieldCheck /> On{info?.enrolledAt ? ` since ${new Date(info.enrolledAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''} ·{' '}
              {info?.recoveryLeft ?? 0} recovery code{info?.recoveryLeft === 1 ? '' : 's'} left
            </p>
            <div className="tfa__choices">
              <button onClick={() => (setStep('code-phone'), setCode(''), setError(''))}>
                <LuSmartphone /> Move to a new phone
              </button>
              <button onClick={() => (setStep('code-recovery'), setCode(''), setError(''))}>
                <LuKeyRound /> New recovery codes
              </button>
            </div>
            <p className="field__hint">Lost your phone and your recovery codes? On the server: <code>bun run auth:reset-2fa</code>, then sign in and set it up again.</p>
          </>
        )}
        {(step === 'code-phone' || step === 'code-recovery') && (
          <form
            className="tfa__confirm"
            onSubmit={(e) => {
              e.preventDefault()
              void withCode()
            }}
          >
            <label className="field">
              <span className="field__label">The current code from your authenticator app</span>
              <CodeInput value={code} onChange={setCode} onComplete={(v) => void withCode(v)} autoFocus disabled={busy} />
              <span className="field__hint">{step === 'code-phone' ? 'Then scan a new QR code with the new phone: the old one stops working.' : 'The old recovery codes stop working.'}</span>
            </label>
            {error && <p className="danger-text">{error}</p>}
            <footer className="modal__foot">
              <button type="button" onClick={() => setStep('home')}>
                Back
              </button>
              <button className="primary" disabled={busy || code.length !== 6}>
                {busy ? 'Checking…' : 'Continue'}
              </button>
            </footer>
          </form>
        )}
        {step === 'phone' && setup && <SetupSteps start={async () => setup} onDone={finish} />}
        {step === 'recovery' && <RecoveryCodes codes={codes} onDone={finish} doneLabel="Done" />}
      </div>
    </Modal>
  )
}
