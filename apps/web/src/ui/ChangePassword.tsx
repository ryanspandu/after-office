import { useState } from 'react'
import { LuCheck, LuCopy, LuEye, LuEyeOff, LuWandSparkles } from 'react-icons/lu'
import { api, useAuth } from '../state/auth'
import { Modal } from './Modal'
import { tip } from './Tooltip'
import { CodeInput } from './TwoFactor'

// Change the dashboard password (Profile → Change password, ?password=1). The server checks the current one, and
// every other browser has to sign in again afterwards. "Generate" makes a strong random one, right here in the browser.

const MIN = 12
// no look-alikes (0/O, 1/l/I) so it can be typed from a phone screen
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*-_=+?'

export function generatePassword(length = 20) {
  const out: string[] = []
  const buf = new Uint32Array(1)
  while (out.length < length) {
    crypto.getRandomValues(buf)
    // rejection sampling: every character equally likely
    const limit = Math.floor(0x1_0000_0000 / ALPHABET.length) * ALPHABET.length
    if (buf[0] < limit) out.push(ALPHABET[buf[0] % ALPHABET.length])
  }
  return out.join('')
}

function PasswordInput({ value, onChange, autoComplete, show, onToggle, autoFocus }: { value: string; onChange: (v: string) => void; autoComplete: string; show: boolean; onToggle: () => void; autoFocus?: boolean }) {
  return (
    <span className="auth__pw">
      <input type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} autoFocus={autoFocus} spellCheck={false} />
      <button type="button" className="icon-btn small ghost" onClick={onToggle} {...tip(show ? 'Hide password' : 'Show password')}>
        {show ? <LuEyeOff /> : <LuEye />}
      </button>
    </span>
  )
}

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNext, setShowNext] = useState(false)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [code, setCode] = useState('')
  const user = useAuth((s) => s.user) ?? ''

  const problem = !next ? '' : next.length < MIN ? `At least ${MIN} characters.` : confirm && confirm !== next ? "The two new passwords don't match." : ''
  const ready = !!current && next.length >= MIN && confirm === next && code.length === 6 && !busy

  const generate = () => {
    const pw = generatePassword()
    setNext(pw)
    setConfirm(pw)
    setShowNext(true)
    setCopied(false)
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(next)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setError('Copy failed: select the password and copy it yourself.')
    }
  }

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ current, next, code }) })
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Request failed (${res.status})`)
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the password')
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  if (done)
    return (
      <Modal open onClose={onClose} title="Password changed" width={440}>
        <div className="modal__body">
          <p>Your new password works from now on. Every other device was signed out and needs it to sign in again; this one stays signed in.</p>
          <footer className="modal__foot">
            <button className="primary" onClick={onClose}>
              Done
            </button>
          </footer>
        </div>
      </Modal>
    )

  return (
    <Modal open onClose={onClose} title="Change password" description="Other devices are signed out afterwards." width={460}>
      <form
        className="modal__body change-pw"
        onSubmit={(e) => {
          e.preventDefault()
          if (ready) void save()
        }}
      >
        {/* lets the browser's password manager tie the new password to this account */}
        <input type="text" name="username" autoComplete="username" value={user} readOnly hidden />
        <label className="field">
          <span className="field__label">Current password</span>
          <PasswordInput value={current} onChange={setCurrent} autoComplete="current-password" show={showCurrent} onToggle={() => setShowCurrent((v) => !v)} autoFocus />
        </label>
        <div className="field">
          <span className="field__label change-pw__label">
            New password
            <button type="button" className="small ghost" onClick={generate} {...tip('Make a strong random password (20 characters)')}>
              <LuWandSparkles /> Generate
            </button>
          </span>
          <PasswordInput value={next} onChange={(v) => (setNext(v), setCopied(false))} autoComplete="new-password" show={showNext} onToggle={() => setShowNext((v) => !v)} />
          {next && (
            <span className="change-pw__tools">
              <button type="button" className="small" onClick={() => void copy()}>
                {copied ? <LuCheck /> : <LuCopy />} {copied ? 'Copied' : 'Copy'}
              </button>
              <span className="field__hint">Save it in your password manager before you continue.</span>
            </span>
          )}
        </div>
        <label className="field">
          <span className="field__label">Repeat the new password</span>
          <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" show={showNext} onToggle={() => setShowNext((v) => !v)} />
          <span className={`field__hint${problem ? ' danger-text' : ''}`}>{problem || `At least ${MIN} characters.`}</span>
        </label>
        <label className="field">
          <span className="field__label">Code from your authenticator app</span>
          <CodeInput value={code} onChange={setCode} />
        </label>
        {error && <p className="danger-text">{error}</p>}
        <footer className="modal__foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!ready}>
            {busy ? 'Changing…' : 'Change password'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
