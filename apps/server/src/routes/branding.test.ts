import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { AgentError } from '../agents/errors'
import { brandingRoutes, DEFAULT_NAME, DEFAULT_TAGLINE, logoType } from './branding'

// The office's name, tagline and logo: After Office's own until changed; '' goes back to the default.
const app = new Hono()
app.onError((e, c) => (e instanceof AgentError ? c.json({ error: e.message }, e.status) : c.json({ error: 'x' }, 500)))
app.route('/api', brandingRoutes)
const json = (method: string, path: string, body: unknown) =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const dataUrl = (b: Uint8Array, type = 'image/png') => `data:${type};base64,${Buffer.from(b).toString('base64')}`

test('branding: defaults, change, logo, reset', async () => {
  let b = (await (await app.request('/api/branding')).json()) as { name: string; tagline: string; logo: string | null }
  expect([b.name, b.tagline, b.logo]).toEqual([DEFAULT_NAME, DEFAULT_TAGLINE, null])

  b = await (await json('PUT', '/api/branding', { name: '  Ryan HQ\n', tagline: 'Agents at work' })).json()
  expect([b.name, b.tagline]).toEqual(['Ryan HQ', 'Agents at work'])

  // pictures only, told by their bytes: an SVG (or anything else) with an image type is refused
  expect((await json('PUT', '/api/branding/logo', { data: dataUrl(new TextEncoder().encode('<svg onload="x"/>'), 'image/svg+xml') })).status).toBe(400)
  expect((await json('PUT', '/api/branding/logo', { data: dataUrl(new TextEncoder().encode('not a png at all')) })).status).toBe(400)
  b = await (await json('PUT', '/api/branding/logo', { data: dataUrl(PNG) })).json()
  expect(b.logo).toMatch(/^\/api\/branding\/logo\?v=\d+$/)
  const logo = await app.request('/api/branding/logo')
  expect(logo.headers.get('content-type')).toBe('image/png')
  expect(new Uint8Array(await logo.arrayBuffer())).toEqual(PNG)

  // back to the defaults
  b = await (await json('PUT', '/api/branding', { name: '', tagline: '' })).json()
  expect([b.name, b.tagline]).toEqual([DEFAULT_NAME, DEFAULT_TAGLINE])
  b = await (await app.request('/api/branding/logo', { method: 'DELETE' })).json()
  expect(b.logo).toBeNull()
  expect((await app.request('/api/branding/logo')).status).toBe(404)
})

// the installed app follows the branding: name, description, and icons made from the logo (all sizes, or none)
test('PWA manifest and app icons', async () => {
  const png = (n: number) => {
    const b = new Uint8Array(33)
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
    new DataView(b.buffer).setUint32(16, n)
    new DataView(b.buffer).setUint32(20, n)
    return dataUrl(b)
  }
  const icons = { '32': png(32), '192': png(192), '512': png(512), 'maskable-512': png(512), '180': png(180) }
  let m = (await (await app.request('/api/branding/manifest')).json()) as { name: string; icons: { src: string }[] }
  expect(m.name).toBe(DEFAULT_NAME)
  expect(m.icons[0].src).toStartWith('/icons/icon-192.png')

  await json('PUT', '/api/branding', { name: 'Ryan Headquarters', tagline: 'Agents at work' })
  // a wrong size is refused
  expect((await json('PUT', '/api/branding/logo', { data: dataUrl(PNG), icons: { ...icons, '192': png(100) } })).status).toBe(400)
  const b = (await (await json('PUT', '/api/branding/logo', { data: dataUrl(PNG), icons })).json()) as { favicon: string; appleIcon: string }
  expect(b.favicon).toMatch(/^\/api\/branding\/icon\/32\?v=/)
  expect(b.appleIcon).toMatch(/^\/api\/branding\/icon\/180\?v=/)
  m = await (await app.request('/api/branding/manifest')).json()
  expect(m).toMatchObject({ name: 'Ryan Headquarters', short_name: 'Ryan', description: 'Agents at work' })
  expect(m.icons.map((i) => i.src.split('?')[0])).toEqual(['/api/branding/icon/192', '/api/branding/icon/512', '/api/branding/icon/maskable-512'])
  expect((await app.request('/api/branding/icon/512')).headers.get('content-type')).toBe('image/png')
  expect((await app.request('/api/branding/icon/../x')).status).toBe(404)

  await json('PUT', '/api/branding', { name: '', tagline: '' })
  await app.request('/api/branding/logo', { method: 'DELETE' })
  m = await (await app.request('/api/branding/manifest')).json()
  expect([m.name, m.icons[0].src.split('?')[0]]).toEqual([DEFAULT_NAME, '/icons/icon-192.png'])
})

test('logo types by their first bytes', () => {
  expect(logoType(PNG)).toBe('png')
  expect(logoType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg')
  expect(logoType(new TextEncoder().encode('RIFF....WEBPVP8 '))).toBe('webp')
  expect(logoType(new TextEncoder().encode('<svg/>'))).toBeNull()
})
