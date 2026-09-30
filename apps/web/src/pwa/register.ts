import { create } from 'zustand'

// Service worker registration (production + secure context only: HTTPS or localhost; never in `vite dev`, never on
// a plain-http LAN address). A new deploy ships a new worker; it waits until the user picks "Reload" so an open tab
// never mixes two versions.

export const useAppUpdate = create<{ ready: boolean; apply: () => void }>(() => ({ ready: false, apply: () => {} }))

/** while the app is shown: look for a new version this often */
const UPDATE_EVERY_MS = 5 * 60_000
/** coming back to the app: at most this often */
const UPDATE_ON_RETURN_MS = 60_000

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !window.isSecureContext) return
  window.addEventListener('load', async () => {
    let reg: ServiceWorkerRegistration
    try {
      reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    } catch (e) {
      console.warn('[pwa] service worker not registered:', e)
      return
    }

    const offer = (worker: ServiceWorker) =>
      useAppUpdate.setState({
        ready: true,
        apply: () => worker.postMessage({ type: 'SKIP_WAITING' }),
      })

    // a newer worker already waiting (e.g. installed while this tab was closed)
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting)
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing
      worker?.addEventListener('statechange', () => {
        // "installed" with an existing controller = an update (the very first install needs no reload)
        if (worker.state === 'installed' && navigator.serviceWorker.controller) offer(worker)
      })
    })

    // the new worker took over: load the new version once
    let reloading = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return
      reloading = true
      window.location.reload()
    })

    // look for a new version: every few minutes while the app is shown, and when it comes back to the foreground. The
    // installed app has no browser around it to reload, so it has to notice by itself (then the reload button lights
    // up, ui/AppReload.tsx, and the toast offers it)
    let lastCheck = Date.now()
    const check = (minGap: number) => {
      if (document.visibilityState !== 'visible' || useAppUpdate.getState().ready || Date.now() - lastCheck < minGap) return
      lastCheck = Date.now()
      void reg.update().catch(() => {})
    }
    setInterval(() => check(UPDATE_EVERY_MS - 1000), UPDATE_EVERY_MS)
    document.addEventListener('visibilitychange', () => check(UPDATE_ON_RETURN_MS))
    window.addEventListener('focus', () => check(UPDATE_ON_RETURN_MS))
  })
}
