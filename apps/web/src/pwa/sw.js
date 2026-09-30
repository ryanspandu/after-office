/* After Office service worker. Built into dist/sw.js by the plugin in vite.config.ts, which fills in BUILD_ID and
 * PRECACHE. Plain JS on purpose (worker globals, no bundling).
 *
 * What it does, and what it deliberately does not:
 * - pages: network first, always; offline.html only when the server can't be reached (never an old app shell);
 * - /assets/* (content-hashed): cache first, trimmed to MAX_ASSETS entries;
 * - icons, logo, offline page: precached;
 * - the API, the event stream, hooks, MCP, webhooks, anything not GET or not same-origin: never touched, so live
 *   data is never served from a cache and nothing sensitive is stored on the device.
 */
const BUILD_ID = '__BUILD_ID__'
const PRECACHE = __PRECACHE__
const STATIC = `ao-static-${BUILD_ID}`
const ASSETS = 'ao-assets'
const MAX_ASSETS = 80
const NEVER = ['/api/', '/trigger/', '/hook', '/mcp', '/statusline']

self.addEventListener('install', (event) => {
  // no skipWaiting here: the page asks for it when the user chooses to reload (no mixed versions in an open tab)
  event.waitUntil(caches.open(STATIC).then((c) => c.addAll(PRECACHE)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k.startsWith('ao-static-') && k !== STATIC).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

async function trim(cache) {
  const keys = await cache.keys()
  for (let i = 0; i < keys.length - MAX_ASSETS; i++) await cache.delete(keys[i])
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (NEVER.some((p) => url.pathname.startsWith(p))) return
  if ((req.headers.get('accept') || '').includes('text/event-stream')) return

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => (await caches.match('/offline.html', { cacheName: STATIC })) || Response.error()),
    )
    return
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSETS)
        const hit = await cache.match(req)
        if (hit) return hit
        const res = await fetch(req)
        if (res.ok) {
          await cache.put(req, res.clone())
          trim(cache)
        }
        return res
      })(),
    )
    return
  }

  if (PRECACHE.includes(url.pathname)) {
    // stale-while-revalidate: instant, and refreshed for next time
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC)
        const hit = await cache.match(req)
        const fresh = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone())
            return res
          })
          .catch(() => hit)
        return hit || fresh
      })(),
    )
  }
})

// ── notifications (Web Push, see apps/server/src/push.ts) ──
// The server sends { title, body, url, tag }, encrypted for this device. Shown even when the app is closed.
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  const title = data.title || 'After Office'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/favicon-32.png',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/' },
    }),
  )
})

// a tap opens the dashboard where the notification points: an open window is reused, else a new one
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const win = wins.find((w) => new URL(w.url).origin === self.location.origin)
      if (win) {
        await win.focus()
        return win.navigate(url).catch(() => self.clients.openWindow(url))
      }
      return self.clients.openWindow(url)
    })(),
  )
})
