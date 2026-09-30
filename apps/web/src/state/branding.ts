import { create } from 'zustand'

// The office's name, tagline and logo (Project settings in the Profile modal). After Office's own until changed.
// Readable without signing in, so the sign-in page shows them too.

export const DEFAULT_BRANDING = { name: 'After Office', tagline: 'Live agent workspace', logo: null as string | null }
export const DEFAULT_LOGO = '/logo.png'

export interface Branding {
  name: string
  tagline: string
  /** custom logo url, or null for the default one */
  logo: string | null
  /** browser tab icon (32×32) and iOS home screen icon (180×180), made from a custom logo */
  favicon?: string | null
  appleIcon?: string | null
  custom: { name: boolean; tagline: boolean; logo: boolean }
  /** read from the server (or given up on): until then the brand shows a skeleton, not After Office's own */
  loaded?: boolean
}

export const useBranding = create<Branding>(() => ({ ...DEFAULT_BRANDING, custom: { name: false, tagline: false, logo: false }, loaded: false }))

/** The browser tab: its title (a reply counter may be put in front, see replyAlerts.ts) and icon. */
export const brandTitle = () => useBranding.getState().name

function applyToDocument(b: Branding) {
  if (!/^\(\d+\) /.test(document.title)) document.title = b.name
  else document.title = document.title.replace(/^(\(\d+\) ).*/, `$1${b.name}`)
  // favicon (32 px and the large one), iOS home screen icon and title: the logo's, or After Office's own
  const swap = (el: HTMLLinkElement, custom: string | null | undefined) => {
    el.dataset.default ??= el.href
    el.href = custom ?? el.dataset.default
  }
  document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]').forEach((el) => swap(el, el.sizes.value === '32x32' ? (b.favicon ?? b.logo) : b.logo))
  const apple = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')
  if (apple) swap(apple, b.appleIcon ?? b.logo)
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', b.name)
}

export function setBranding(b: Branding) {
  useBranding.setState({ ...b, loaded: true })
  applyToDocument(b)
}

export async function loadBranding() {
  try {
    const res = await fetch('/api/branding', { credentials: 'same-origin' })
    if (res.ok) return setBranding(await res.json())
  } catch {
    // offline: the defaults below
  }
  useBranding.setState({ loaded: true })
}
