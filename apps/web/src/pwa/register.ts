import { create } from 'zustand'

// Service worker registration (production + secure context only: HTTPS or localhost; never in `vite dev`, never on
// a plain-http LAN address). A new deploy ships a new worker; it waits until the user picks "Reload" so an open tab
// never mixes two versions.

export const useAppUpdate = create<{ ready: boolean; apply: () => void }>(() => ({ ready: false, apply: () => {} }))

const UPDATE_CHECK_MS = 30 * 60_000

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

    // look for a new version when the app comes back to the foreground (at most every 30 min)
    let lastCheck = Date.now()
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastCheck < UPDATE_CHECK_MS) return
      lastCheck = Date.now()
      void reg.update().catch(() => {})
    })
  })
}
