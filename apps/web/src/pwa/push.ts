import { api } from '../state/auth'

// Web Push on this device: ask for permission, subscribe with the server's key, and tell the server. The service
// worker (sw.js) shows what arrives. iPhone/iPad: only in the app added to the Home Screen (iOS 16.4+).

export interface PushDevice {
  id: string
  label: string
  createdAt: number
  lastOkAt?: number
}

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

/** Can this browser get notifications from the app, and if not, why not (to tell the owner what to do). */
export async function pushSupport(): Promise<{ ok: true; reg: ServiceWorkerRegistration } | { ok: false; why: 'ios-install' | 'insecure' | 'no-worker' | 'unsupported' | 'denied' }> {
  if (!window.isSecureContext) return { ok: false, why: 'insecure' }
  if (isIos() && !standalone()) return { ok: false, why: 'ios-install' }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return { ok: false, why: 'unsupported' }
  if (Notification.permission === 'denied') return { ok: false, why: 'denied' }
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) return { ok: false, why: 'no-worker' }
  return { ok: true, reg }
}

function keyBytes(base64url: string) {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4)
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
}

async function json<T>(r: Response): Promise<T> {
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${r.status})`)
  return data as T
}

export const pushState = () => api('/api/push').then((r) => json<{ publicKey: string; devices: PushDevice[] }>(r))

/** This browser's device id on the server, if it's on. */
export async function thisDevice(reg: ServiceWorkerRegistration) {
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return null
  const r = await api('/api/push/devices/lookup', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) })
  return (await json<{ id: string | null }>(r)).id
}

/** Turn notifications on here (asks the browser for permission: call it from a tap). */
export async function enablePush(reg: ServiceWorkerRegistration, label: string) {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications are blocked for this site: allow them in the browser settings.' : 'Notifications were not allowed.')
  const { publicKey } = await pushState()
  let sub = await reg.pushManager.getSubscription()
  // made with another key (the server's changed): start over
  if (sub) {
    const current = sub.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null
    const wanted = keyBytes(publicKey)
    if (!current || current.length !== wanted.length || current.some((b, i) => b !== wanted[i])) {
      await sub.unsubscribe()
      sub = null
    }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
  const r = await api('/api/push/devices', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON(), label }) })
  return json<{ id: string; devices: PushDevice[] }>(r)
}

export async function removeDevice(id: string, reg?: ServiceWorkerRegistration | null, isThis = false) {
  if (isThis && reg) await (await reg.pushManager.getSubscription())?.unsubscribe().catch(() => false)
  const r = await api(`/api/push/devices/${id}`, { method: 'DELETE' })
  return json<{ devices: PushDevice[] }>(r)
}

export async function testPush(id?: string) {
  const r = await api('/api/push/test', { method: 'POST', body: JSON.stringify(id ? { id } : {}) })
  return json<{ results: { device: string; ok: boolean; error?: string }[]; devices: PushDevice[] }>(r)
}
