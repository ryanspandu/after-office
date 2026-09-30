import { create } from 'zustand'
import { useAppUpdate } from './register'

// "Install app": Chromium (Android, desktop) offers a prompt event we keep until the user asks; iOS Safari has no
// prompt, so we explain Share → Add to Home Screen instead. Nothing shows once the app runs installed.

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true

const ua = navigator.userAgent
/** iPhone / iPad Safari (iPadOS reports itself as a Mac with touch). */
export const isIosSafari =
  (/iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1)) && !/CriOS|FxiOS|EdgiOS/.test(ua)

export const useInstall = create<{ prompt: BeforeInstallPromptEvent | null; installed: boolean }>(() => ({
  prompt: null,
  installed: isStandalone(),
}))

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault() // our own button asks, not the browser's mini-infobar
  useInstall.setState({ prompt: e as BeforeInstallPromptEvent })
})
window.addEventListener('appinstalled', () => useInstall.setState({ prompt: null, installed: true }))

export async function installApp() {
  const p = useInstall.getState().prompt
  if (!p) return
  await p.prompt()
  await p.userChoice.catch(() => null)
  useInstall.setState({ prompt: null }) // a prompt can be used once
}

/** Show an "Install" entry: a real prompt (Chromium), or the iOS how-to (Safari, not yet installed). */
export const canOfferInstall = (s: { prompt: unknown; installed: boolean }) => !s.installed && (!!s.prompt || isIosSafari)

/**
 * Reload, for the installed app (it has no browser reload button). A new version already waiting is taken (the page
 * reloads once it has taken over, pwa/register.ts); otherwise it looks for one first, then loads the page again.
 */
export async function reloadApp() {
  const update = useAppUpdate.getState()
  if (update.ready) return update.apply()
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    await Promise.race([reg?.update(), new Promise((r) => setTimeout(r, 1500))])
    // found one just now: take it (controllerchange reloads)
    if (reg?.waiting && navigator.serviceWorker.controller) {
      reg.waiting.postMessage({ type: 'SKIP_WAITING' })
      setTimeout(() => location.reload(), 3000)
      return
    }
  } catch {
    // offline or no worker: reload anyway
  }
  location.reload()
}
