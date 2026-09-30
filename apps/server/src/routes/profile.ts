import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { DATA_DIR, settingsRepo } from '../db'
import { AgentError } from '../agents/errors'
import { logoType } from './branding'

// The owner's profile picture (Profile → Edit profile): a small square picture, cropped in the browser. Signed-in only.

const DIR = join(DATA_DIR, 'profile')
const FILE = join(DIR, 'avatar')
const VERSION_KEY = 'avatarVersion'
const MAX_BYTES = 512 * 1024

/** Its address (with a version, so a new picture isn't served from the cache), or null. */
export function avatarUrl() {
  return existsSync(FILE) ? `/api/profile/avatar?v=${settingsRepo.get(VERSION_KEY) ?? '0'}` : null
}
const bump = () => settingsRepo.set(VERSION_KEY, String(Number(settingsRepo.get(VERSION_KEY) ?? '0') + 1))

export const profileRoutes = new Hono()

profileRoutes.get('/profile/avatar', async (c) => {
  if (!existsSync(FILE)) return c.json({ error: 'No picture' }, 404)
  const bytes = new Uint8Array(await Bun.file(FILE).arrayBuffer())
  const type = logoType(bytes)
  return new Response(bytes, {
    headers: { 'content-type': type === 'jpg' ? 'image/jpeg' : `image/${type ?? 'png'}`, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' },
  })
})

profileRoutes.put('/profile/avatar', async (c) => {
  const { data } = await c.req.json<{ data?: unknown }>().catch(() => ({ data: undefined }))
  const m = typeof data === 'string' ? /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(data) : null
  if (!m) throw new AgentError('Send the picture as a PNG, JPG or WebP')
  const bytes = new Uint8Array(Buffer.from(m[2], 'base64'))
  if (bytes.byteLength > MAX_BYTES) throw new AgentError('The picture must be 512 KB or smaller', 413)
  if (!logoType(bytes)) throw new AgentError('The picture must be a PNG, JPG or WebP')
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  writeFileSync(FILE, bytes, { mode: 0o600 })
  bump()
  return c.json({ avatar: avatarUrl() })
})

profileRoutes.delete('/profile/avatar', (c) => {
  rmSync(FILE, { force: true })
  bump()
  return c.json({ avatar: null })
})
