import { Hono } from 'hono'
import { serveStatic, websocket } from 'hono/bun'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import type { DirListing } from '@after-office/shared'
import { AGENTS_DIR, DEFAULT_DIR, expandPath, real, ROOTS, rootOf } from './fsroots'
import {
  changePassword,
  changeUsername,
  listSessions,
  login,
  loginCode,
  logout,
  logoutEverywhere,
  logoutOthers,
  me,
  requireAuth,
  requireHookToken,
  requireJsonForWrites,
  requestWho,
  revokeSession,
  setAvatarSource,
  setBrandNameSource,
  twoFactorEnable,
  twoFactorNewRecovery,
  twoFactorReset,
  twoFactorSetup,
} from './auth'
import { handleHook, handleStatusline } from './agents/ingest'
import { handleMcp } from './mcp'
import { startBackgroundJobs } from './agents/reconciler'
import { agentRoutes } from './routes/agents'
import { workRoutes } from './routes/work'
import { checkTrigger, startWorkJobs, triggerCron } from './work/work'
import { bodyLimit } from 'hono/body-limit'
import type { Context } from 'hono'
import { AgentError } from './agents/manager'
import { startBackups } from './backup'
import { startNotifications } from './notify'
import { branding, brandingRoutes } from './routes/branding'
import { avatarUrl, profileRoutes } from './routes/profile'

import { startPreviewProxies } from './work/previews'

const app = new Hono()

// Browser security headers on everything this server sends. The CSP allows only this origin (plus Google Fonts):
// no inline scripts, no third-party images (agent text can't make the browser fetch URLs), no framing.
app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      workerSrc: ["'self'", 'blob:'],
      manifestSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
    crossOriginEmbedderPolicy: false,
    permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
    strictTransportSecurity: process.env.NODE_ENV === 'production' ? 'max-age=31536000; includeSubDomains' : false,
  }),
)
app.use('/api/*', logger())

app.get('/health', (c) => c.json({ ok: true }))

// ── auth: everything under /api needs a session, except the auth endpoints themselves ──
// small bodies for the one route anyone can reach
app.use('/api/auth/login/*', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'Too large' }, 413) }))
app.use('/api/auth/login', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'Too large' }, 413) }))
app.use('/api/profile/avatar', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'The picture must be 512 KB or smaller' }, 413) }))
app.use('/api/branding/logo', bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json({ error: 'The logo must be 1 MB or smaller' }, 413) }))
app.use('/api/*', requireJsonForWrites, requireAuth)
app.post('/api/auth/login', login)
app.post('/api/auth/login/code', loginCode)
app.post('/api/auth/2fa/setup', twoFactorSetup)
app.post('/api/auth/2fa/enable', twoFactorEnable)
app.post('/api/auth/2fa/reset', twoFactorReset)
app.post('/api/auth/2fa/recovery', twoFactorNewRecovery)
app.post('/api/auth/logout', logout)
app.post('/api/auth/logout-all', logoutEverywhere)
app.post('/api/auth/logout-others', logoutOthers)
app.post('/api/auth/password', changePassword)
app.post('/api/auth/username', changeUsername)
app.get('/api/auth/sessions', listSessions)
app.delete('/api/auth/sessions/:id', revokeSession)
app.get('/api/auth/me', me)

app.route('/api', agentRoutes)
app.route('/api', brandingRoutes)
app.route('/api', profileRoutes)
// the authenticator app shows the office's name next to the codes
setBrandNameSource(() => branding().name)
setAvatarSource(avatarUrl)
app.route('/api', workRoutes)

// Folder picker for new agents: directories under the allowed roots (fsroots.ts) only.
app.get('/api/fs', async (c) => {
  const q = c.req.query('path') ?? ''
  // symlinks resolved: a link inside a root must not open a listing outside it
  const path = real(q ? expandPath(q) : DEFAULT_DIR)
  const root = rootOf(path)
  if (!root) return c.json({ error: `Folder must be inside ${ROOTS.join(' or ')}` }, 403)
  try {
    const entries = await readdir(path, { withFileTypes: true })
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
    const body: DirListing = { root, path, relative: relative(root, path), dirs, roots: ROOTS, defaultDir: DEFAULT_DIR, agentsDir: AGENTS_DIR }
    return c.json(body)
  } catch {
    return c.json({ error: 'not readable', path, root, roots: ROOTS }, 404)
  }
})

// ── from Claude Code itself (bearer HOOK_TOKEN, set per agent by the manager) ──
app.post('/hook', requireHookToken, handleHook)
app.post('/statusline', requireHookToken, handleStatusline)
// ── public: a webhook runs a cron job (per-cron secret token; see Automation → cron "Webhook trigger") ──
const triggerToken = (c: Context) => {
  const auth = c.req.header('authorization')
  return auth?.startsWith('Bearer ') ? auth.slice(7).trim() : (c.req.query('token') ?? '')
}
app.post(
  '/trigger/cron/:id',
  // the token is checked before any of the body is read
  async (c, next) => {
    try {
      checkTrigger(c.req.param('id'), triggerToken(c))
    } catch (e) {
      if (e instanceof AgentError) return c.json({ error: e.message }, e.status)
      throw e
    }
    return next()
  },
  bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'Payload too large (64 KB max)' }, 413) }),
  async (c) => {
  const token = triggerToken(c)
  const payload = await c.req.text().catch(() => '')
  try {
    const delivery = await triggerCron(c.req.param('id'), token, payload, requestWho(c).ip)
    return c.json({ ok: true, delivery })
  } catch (e) {
    if (e instanceof AgentError) return c.json({ error: e.message }, e.status)
    console.error('[trigger]', e)
    return c.json({ error: 'Something went wrong' }, 500)
  }
  },
)

// the manager agent's tools (MCP, Streamable HTTP); same bearer token, only the manager's X-AO-Agent is accepted
app.all('/mcp', requireHookToken, handleMcp)

// ── production: the built dashboard (bun run build) is served from here, one process behind Caddy ──
const WEB_DIST = resolve(process.env.OFFICE_WEB_DIST ?? resolve(import.meta.dir, '../../web/dist'))
if (existsSync(resolve(WEB_DIST, 'index.html'))) {
  app.use(
    '/*',
    serveStatic({
      root: WEB_DIST,
      // file names under assets/ carry a content hash: cache them forever
      onFound: (path, c) => {
        c.header('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
      },
    }),
  )
  // client-side routes fall back to the app shell
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'Not found' }, 404)
    // app files (service worker, manifest, icons…) that are missing must 404: an HTML page in their place would
    // install a broken service worker or manifest
    if (/\.[a-z0-9]+$/i.test(c.req.path)) return c.json({ error: 'Not found' }, 404)
    c.header('Cache-Control', 'no-cache')
    return c.html(await Bun.file(resolve(WEB_DIST, 'index.html')).text())
  })
} else if (process.env.NODE_ENV === 'production') {
  console.warn(`[web] ${WEB_DIST}/index.html not found: run \`bun run build\` first (only the API is served)`)
}

startBackgroundJobs()
startNotifications()
startWorkJobs()
startBackups()
startPreviewProxies()

const port = Number(process.env.OFFICE_PORT ?? 8787)
// production listens on loopback only: Caddy terminates HTTPS in front, hooks come from the same machine
// loopback only unless asked (OFFICE_HOST=0.0.0.0): Caddy (VPS) or Vite (dev) sit in front; hooks come from this machine
const hostname = process.env.OFFICE_HOST || '127.0.0.1'
console.log(`After Office on http://${hostname}:${port}`)

// idleTimeout 0: held PermissionRequest hooks and SSE streams stay open for minutes.
// maxRequestBodySize: hooks carry whole files an agent writes, but nothing needs more than 16 MB.
export default { port, hostname, fetch: app.fetch, websocket, idleTimeout: 0, maxRequestBodySize: 16 * 1024 * 1024 }
