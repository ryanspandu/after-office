import { useRef, useState } from 'react'
import { LuDownload, LuImageUp, LuRotateCcw, LuTrash2, LuUpload } from 'react-icons/lu'
import { api } from '../state/auth'
import { DEFAULT_BRANDING, DEFAULT_LOGO, setBranding, useBranding, type Branding } from '../state/branding'
import { Modal } from './Modal'
import { ExportOfficeModal, ImportOfficeModal } from './MoveOffice'
import { ProxySection } from './ProxySettings'

// Project settings (from the Profile modal, ?settings=1): the office's name, tagline and logo, shown in the navbar,
// on the sign-in page and in the browser tab. Empty fields and no logo mean After Office's own.

const MAX_LOGO = 1024 * 1024

/** The app icons made from the logo: square PNGs, cropped to the middle (browser tab, installed app, iOS). */
const ICON_SIZES = { '32': 32, '192': 192, '512': 512, 'maskable-512': 512, '180': 180 } as const
async function makeIcons(dataUrl: string): Promise<Record<string, string>> {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const side = Math.min(img.naturalWidth, img.naturalHeight)
  const sx = (img.naturalWidth - side) / 2
  const sy = (img.naturalHeight - side) / 2
  const out: Record<string, string> = {}
  for (const [key, size] of Object.entries(ICON_SIZES)) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    if (key === 'maskable-512') {
      // Android crops maskable icons to a circle or squircle: keep the logo inside the middle 80%
      ctx.fillStyle = '#efefed'
      ctx.fillRect(0, 0, size, size)
      const inner = size * 0.8
      ctx.drawImage(img, sx, sy, side, side, (size - inner) / 2, (size - inner) / 2, inner, inner)
    } else {
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size)
    }
    out[key] = canvas.toDataURL('image/png')
  }
  return out
}

async function send(path: string, method: string, body?: unknown): Promise<Branding> {
  const res = await api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Request failed (${res.status})`)
  return res.json()
}

export function ProjectSettingsModal({ onClose }: { onClose: () => void }) {
  const current = useBranding()
  const [name, setName] = useState(current.custom.name ? current.name : '')
  const [tagline, setTagline] = useState(current.custom.tagline ? current.tagline : '')
  // a new logo picked but not saved yet (data URL), or 'remove'
  const [logo, setLogo] = useState<string | 'remove' | null>(null)
  const [busy, setBusy] = useState(false)
  // Move this office: export everything to a file, or import one (each its own window)
  const [move, setMove] = useState<'export' | 'import' | null>(null)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)

  const shownLogo = logo === 'remove' ? DEFAULT_LOGO : (logo ?? current.logo ?? DEFAULT_LOGO)
  const hasCustomLogo = logo === 'remove' ? false : !!logo || current.custom.logo
  const dirty = name !== (current.custom.name ? current.name : '') || tagline !== (current.custom.tagline ? current.tagline : '') || logo !== null

  const pick = (file?: File) => {
    if (!file) return
    setError('')
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return setError('Pick a PNG, JPG or WebP picture.')
    if (file.size > MAX_LOGO) return setError('The logo must be 1 MB or smaller.')
    const reader = new FileReader()
    reader.onload = () => setLogo(String(reader.result))
    reader.readAsDataURL(file)
  }

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      let b = await send('/api/branding', 'PUT', { name: name.trim(), tagline: tagline.trim() })
      if (logo === 'remove') b = await send('/api/branding/logo', 'DELETE')
      else if (logo) b = await send('/api/branding/logo', 'PUT', { data: logo, icons: await makeIcons(logo) })
      setBranding(b)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Office settings" description="How this office looks: navbar, sign-in page and browser tab." width={480}>
      <form
        className="modal__body project-settings"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="field">
          <span className="field__label">Logo</span>
          <div className="project-settings__logo">
            <img src={shownLogo} alt="" width={56} height={56} />
            <div className="project-settings__logo-actions">
              <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => (pick(e.target.files?.[0]), (e.target.value = ''))} />
              <button type="button" className="small" onClick={() => input.current?.click()}>
                <LuImageUp /> Upload logo
              </button>
              {hasCustomLogo && (
                <button type="button" className="small ghost" onClick={() => setLogo('remove')}>
                  <LuTrash2 /> Use the default
                </button>
              )}
            </div>
          </div>
          <span className="field__hint">PNG, JPG or WebP, square, up to 1 MB. Also the browser tab's icon and the installed app's icon (cropped to a square).</span>
        </div>
        <label className="field">
          <span className="field__label">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder={DEFAULT_BRANDING.name} />
        </label>
        <label className="field">
          <span className="field__label">Description</span>
          <input value={tagline} onChange={(e) => setTagline(e.target.value)} maxLength={80} placeholder={DEFAULT_BRANDING.tagline} />
          <span className="field__hint">Leave a field empty to use the default.</span>
        </label>
        <ProxySection />
        <div className="field project-settings__move">
          <span className="field__label">Move this office</span>
          <div className="project-settings__move-actions">
            <button type="button" className="small" onClick={() => setMove('export')}>
              <LuDownload /> Export all data
            </button>
            <button type="button" className="small" onClick={() => setMove('import')}>
              <LuUpload /> Import
            </button>
          </div>
          <span className="field__hint">Everything in one file (database, agents’ folders, conversations), to move to another server or keep as a full backup. Both ask for your two-factor code.</span>
        </div>
        {error && <p className="danger-text">{error}</p>}
        <footer className="modal__foot">
          <button
            type="button"
            className="ghost project-settings__reset"
            disabled={busy || (!name && !tagline && !hasCustomLogo)}
            onClick={() => {
              setName('')
              setTagline('')
              setLogo(current.custom.logo ? 'remove' : null)
            }}
            data-tip="Back to After Office's name, description and logo (saved when you press Save)"
          >
            <LuRotateCcw /> Reset to default
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </form>
      {/* outside the form: a submit in them mustn't reach this one (React events cross portals) */}
      {move === 'export' && <ExportOfficeModal onClose={() => setMove(null)} />}
      {move === 'import' && <ImportOfficeModal onClose={() => setMove(null)} />}
    </Modal>
  )
}
