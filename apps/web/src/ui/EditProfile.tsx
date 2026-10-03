import { useRef, useState } from 'react'
import { LuCamera, LuTrash2 } from 'react-icons/lu'
import { api, useAuth } from '../state/auth'
import { Modal } from './Modal'
import { CodeInput } from './TwoFactor'

// Profile → Edit profile (?editprofile=1): the owner's picture and sign-in name. The picture is cropped to a square in
// the browser (256 px); a new username needs the authenticator code, and signs every other browser out.

const USERNAME_RE = /^[a-zA-Z0-9._-]{2,32}$/
const SIZE = 256

/** The owner's picture, or their initial. */
export function OwnerAvatar({ className = '' }: { className?: string }) {
  const user = useAuth((s) => s.user)
  const avatar = useAuth((s) => s.avatar)
  return avatar ? (
    <img className={`avatar avatar--img ${className}`} src={avatar} alt="" />
  ) : (
    <span className={`avatar avatar--owner ${className}`}>{user?.[0]?.toUpperCase()}</span>
  )
}

/** A picture file → a centred square PNG (data URL). */
async function squarePng(file: File) {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const side = Math.min(img.naturalWidth, img.naturalHeight)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = SIZE
    canvas.getContext('2d')!.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, SIZE, SIZE)
    return canvas.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function EditProfileModal({ onClose }: { onClose: () => void }) {
  const user = useAuth((s) => s.user) ?? ''
  const current = useAuth((s) => s.avatar)
  const check = useAuth((s) => s.check)
  const [name, setName] = useState(user)
  // a new picture picked (data URL), 'remove', or unchanged
  const [picture, setPicture] = useState<string | 'remove' | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)

  const renamed = name.trim() !== user
  const nameProblem = renamed && !USERNAME_RE.test(name.trim()) ? '2–32 characters: letters, numbers, dot, dash or underscore.' : ''
  const dirty = renamed || picture !== null
  const ready = dirty && !nameProblem && (!renamed || code.length === 6) && !busy
  const shown = picture === 'remove' ? null : (picture ?? current)

  const pick = async (file?: File) => {
    if (!file) return
    setError('')
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return setError('Pick a PNG, JPG or WebP picture.')
    if (file.size > 10 * 1024 * 1024) return setError('That picture is too large (10 MB max).')
    try {
      setPicture(await squarePng(file))
    } catch {
      setError("Couldn't read that picture.")
    }
  }

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const send = async (path: string, method: string, body?: unknown) => {
        const r = await api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Request failed (${r.status})`)
      }
      if (picture === 'remove') await send('/api/profile/avatar', 'DELETE')
      else if (picture) await send('/api/profile/avatar', 'PUT', { data: picture })
      setPicture(null)
      if (renamed) await send('/api/auth/username', 'POST', { username: name.trim(), code })
      await check()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save')
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Edit profile" width={440}>
      <form
        className="modal__body edit-profile"
        onSubmit={(e) => {
          e.preventDefault()
          if (ready) void save()
        }}
      >
        <div className="edit-profile__picture">
          {shown ? <img className="avatar avatar--img edit-profile__avatar" src={shown} alt="" /> : <span className="avatar edit-profile__avatar">{(name.trim() || user)[0]?.toUpperCase()}</span>}
          <div className="edit-profile__picture-actions">
            <button type="button" className="small" onClick={() => input.current?.click()}>
              <LuCamera /> {shown ? 'Change picture' : 'Add a picture'}
            </button>
            {shown && (
              <button type="button" className="small ghost" onClick={() => setPicture(current || picture ? 'remove' : null)}>
                <LuTrash2 /> Remove
              </button>
            )}
            <span className="field__hint">Cropped to a square from the middle.</span>
          </div>
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => (void pick(e.target.files?.[0]), (e.target.value = ''))} />
        </div>
        <label className="field">
          <span className="field__label">Username</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" spellCheck={false} maxLength={32} />
          <span className={`field__hint${nameProblem ? ' danger-text' : ''}`}>{nameProblem || 'What you sign in with.'}</span>
        </label>
        {renamed && !nameProblem && (
          <label className="field">
            <span className="field__label">Code from your authenticator app</span>
            <CodeInput value={code} onChange={setCode} />
            <span className="field__hint">Other devices are signed out and sign in again with the new name.</span>
          </label>
        )}
        {error && <p className="danger-text">{error}</p>}
        <footer className="modal__foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!ready}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
