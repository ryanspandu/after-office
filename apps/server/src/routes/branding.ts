import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { DATA_DIR, settingsRepo } from '../db'
import { AgentError } from '../agents/errors'

// The office's name, tagline and logo (navbar, sign-in page, browser tab). Unset: After Office's own. Reading them is
// public (the sign-in page shows them before anyone signs in); changing them needs a session (see index.ts).

export const DEFAULT_NAME = 'After Office'
export const DEFAULT_TAGLINE = 'Live agent workspace'
const KEY = 'branding'
const LOGO_DIR = join(DATA_DIR, 'branding')
export const MAX_LOGO_BYTES = 1024 * 1024

interface Stored {
  name?: string
  tagline?: string
  /** bumps with every logo change (cache-busting) */
  logoVersion?: number
}

const load = (): Stored => {
  try {
    return JSON.parse(settingsRepo.get(KEY) ?? '{}')
  } catch {
    return {}
  }
}
const save = (s: Stored) => settingsRepo.set(KEY, JSON.stringify(s))

/** App icons made from the logo in the browser when it's uploaded (square PNGs): the installed app's icons. */
export const ICONS = { '32': 32, '192': 192, '512': 512, 'maskable-512': 512, '180': 180 } as const
type IconKey = keyof typeof ICONS
const iconFile = (k: IconKey) => join(LOGO_DIR, `icon-${k}.png`)
const hasIcons = () => (Object.keys(ICONS) as IconKey[]).every((k) => existsSync(iconFile(k)))

/** PNG width × height (from its IHDR chunk). */
export function pngSize(b: Uint8Array) {
  if (logoType(b) !== 'png' || b.length < 24) return null
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return { w: v.getUint32(16), h: v.getUint32(20) }
}

/** The logo file, if one was uploaded (logo.png / logo.jpg / logo.webp). */
function logoFile() {
  if (!existsSync(LOGO_DIR)) return null
  const name = readdirSync(LOGO_DIR).find((f) => /^logo\.(png|jpg|webp)$/.test(f))
  return name ? join(LOGO_DIR, name) : null
}

/**
 * PNG, JPEG or WebP, told by the file's first bytes (not its name). SVG is refused: opened directly from this origin
 * it could run scripts.
 */
export function logoType(data: Uint8Array): 'png' | 'jpg' | 'webp' | null {
  const b = data
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'webp'
  return null
}

export function branding() {
  const s = load()
  const file = logoFile()
  return {
    name: s.name || DEFAULT_NAME,
    tagline: s.tagline || DEFAULT_TAGLINE,
    logo: file ? `/api/branding/logo?v=${s.logoVersion ?? 0}` : null,
    /** iOS home screen icon (180×180), when the logo was changed */
    appleIcon: file && hasIcons() ? `/api/branding/icon/180?v=${s.logoVersion ?? 0}` : null,
    /** the browser tab's icon (32×32), when the logo was changed */
    favicon: file && hasIcons() ? `/api/branding/icon/32?v=${s.logoVersion ?? 0}` : null,
    custom: { name: !!s.name, tagline: !!s.tagline, logo: !!file },
  }
}

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : undefined)

export const brandingRoutes = new Hono()
brandingRoutes.onError((err, c) => {
  if (err instanceof AgentError) return c.json({ error: err.message }, err.status)
  console.error(err)
  return c.json({ error: 'Something went wrong' }, 500)
})

// public: the sign-in page and the browser tab
brandingRoutes.get('/branding', (c) => c.json(branding()))
brandingRoutes.get('/branding/logo', (c) => {
  const file = logoFile()
  if (!file) return c.json({ error: 'No custom logo' }, 404)
  const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.jpg') ? 'image/jpeg' : 'image/webp'
  return new Response(Bun.file(file), {
    headers: { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' },
  })
})

// the installed app (PWA): its name, description and icons follow the branding
const DEFAULT_ICON_VERSION = 'd820906c'
brandingRoutes.get('/branding/manifest', (c) => {
  const b = branding()
  const v = load().logoVersion ?? 0
  const custom = b.custom.logo && hasIcons()
  const icon = (k: IconKey, fallback: string) => (custom ? `/api/branding/icon/${k}?v=${v}` : `${fallback}?v=${DEFAULT_ICON_VERSION}`)
  const i192 = icon('192', '/icons/icon-192.png')
  // the home-screen label: short, so it isn't cut off
  const short = b.name.length <= 12 ? b.name : (b.name.split(/\s+/)[0] ?? b.name).slice(0, 12)
  const manifest = {
    id: '/',
    name: b.name,
    short_name: short,
    description: b.tagline,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#efefed',
    theme_color: '#efefed',
    icons: [
      { src: i192, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: icon('512', '/icons/icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: icon('maskable-512', '/icons/icon-maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Manager chat', short_name: 'Manager', url: '/?open=manager', icons: [{ src: i192, sizes: '192x192' }] },
      { name: 'Tasks', url: '/?open=tasks', icons: [{ src: i192, sizes: '192x192' }] },
      { name: 'Needs your attention', short_name: 'Attention', url: '/?open=attention', icons: [{ src: i192, sizes: '192x192' }] },
    ],
  }
  return c.body(JSON.stringify(manifest), 200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache' })
})
brandingRoutes.get('/branding/icon/:size', (c) => {
  const k = c.req.param('size') as IconKey
  if (!(k in ICONS) || !existsSync(iconFile(k))) return c.json({ error: 'No such icon' }, 404)
  return new Response(Bun.file(iconFile(k)), {
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' },
  })
})

// signed in: change them ('' goes back to the default)
brandingRoutes.put('/branding', async (c) => {
  const body = await c.req.json<{ name?: unknown; tagline?: unknown }>().catch(() => ({}) as { name?: unknown; tagline?: unknown })
  const s = load()
  const name = clean(body.name, 40)
  const tagline = clean(body.tagline, 80)
  if (name !== undefined) s.name = name || undefined
  if (tagline !== undefined) s.tagline = tagline || undefined
  save(s)
  return c.json(branding())
})
brandingRoutes.put('/branding/logo', async (c) => {
  const { data, icons } = await c.req.json<{ data?: unknown; icons?: Record<string, unknown> }>().catch(() => ({ data: undefined, icons: undefined }))
  const m = typeof data === 'string' ? /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(data) : null
  if (!m) throw new AgentError('Send the logo as a PNG, JPG or WebP picture')
  const bytes = new Uint8Array(Buffer.from(m[1], 'base64'))
  if (bytes.byteLength > MAX_LOGO_BYTES) throw new AgentError('The logo must be 1 MB or smaller', 413)
  const type = logoType(bytes)
  if (!type) throw new AgentError('The logo must be a PNG, JPG or WebP picture')
  // the app icons (square PNGs of the right size, made in the browser); all or none
  const made: [IconKey, Uint8Array][] = []
  if (icons) {
    for (const k of Object.keys(ICONS) as IconKey[]) {
      const im = typeof icons[k] === 'string' ? /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(icons[k] as string) : null
      const png = im ? new Uint8Array(Buffer.from(im[1], 'base64')) : null
      const size = png ? pngSize(png) : null
      if (!png || png.byteLength > MAX_LOGO_BYTES || size?.w !== ICONS[k] || size?.h !== ICONS[k]) throw new AgentError(`App icon ${k} must be a ${ICONS[k]}×${ICONS[k]} PNG`)
      made.push([k, png])
    }
  }
  mkdirSync(LOGO_DIR, { recursive: true, mode: 0o700 })
  for (const f of readdirSync(LOGO_DIR)) rmSync(join(LOGO_DIR, f), { force: true })
  writeFileSync(join(LOGO_DIR, `logo.${type}`), bytes, { mode: 0o600 })
  for (const [k, png] of made) writeFileSync(iconFile(k), png, { mode: 0o600 })
  const s = load()
  save({ ...s, logoVersion: (s.logoVersion ?? 0) + 1 })
  return c.json(branding())
})
brandingRoutes.delete('/branding/logo', (c) => {
  rmSync(LOGO_DIR, { recursive: true, force: true })
  const s = load()
  save({ ...s, logoVersion: (s.logoVersion ?? 0) + 1 })
  return c.json(branding())
})
