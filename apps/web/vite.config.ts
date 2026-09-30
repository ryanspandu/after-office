import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server. Local only by default; `bun run dev:lan` (DEV_LAN=1) also listens on the LAN so the dashboard can be
// opened from a phone on the same Wi-Fi. Never run the dev server on a public machine (the VPS): use the build.
const lan = process.env.DEV_LAN === '1'

/** Files the service worker keeps for offline use (all in public/). */
const PRECACHE = ['/offline.html', '/icons/icon-192.png', '/icons/icon-512.png', '/logo.png', '/favicon-32.png']

/**
 * Builds the service worker (src/pwa/sw.js → dist/sw.js) with a BUILD_ID that changes with every build, so each
 * deploy ships a new worker and open apps offer "New version available". Build only: no service worker in dev.
 */
function serviceWorker(): Plugin {
  return {
    name: 'after-office-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      const id = createHash('sha256').update(Object.keys(bundle).sort().join('\n')).digest('hex').slice(0, 12)
      const source = readFileSync(resolve(__dirname, 'src/pwa/sw.js'), 'utf8')
        .replace("'__BUILD_ID__'", JSON.stringify(id))
        .replace('__PRECACHE__', JSON.stringify(PRECACHE))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: {
    port: 5173,
    host: lan ? true : 'localhost',
    // the dev server must never hand out server secrets or data, whatever path is asked for
    fs: { strict: true, deny: ['.env', '.env.*', '**/data/**', '*.db', '*.db-*'] },
    // 127.0.0.1, not localhost: the API listens on IPv4 loopback only
    proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true }, '/trigger': 'http://127.0.0.1:8787' },
  },
})
