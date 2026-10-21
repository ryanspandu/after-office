import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { markdownToHtml, htmlToMarkdown } from '@after-office/shared'
import { workRoutes } from '../routes/work'
import { keepOwnImages, noteImageFile } from './noteImages'

// Pictures in the owner's notes: only real PNG / JPEG / GIF / WebP go in (by their bytes), only by their own name come
// out, and a note keeps only its own pictures.

const app = new Hono().route('/api', workRoutes)
const upload = (body: Uint8Array<ArrayBuffer>, origin = 'http://office.test') =>
  app.request('/api/note-images', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'a', origin, host: 'office.test' }, body })

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])

test('a PNG is stored and shown back, as an image that is never sniffed', async () => {
  const r = await upload(PNG)
  expect(r.status).toBe(200)
  const { url } = (await r.json()) as { url: string }
  expect(url).toMatch(/^\/api\/note-images\/[0-9a-f-]{36}\.png$/)
  const got = await app.request(url)
  expect(got.status).toBe(200)
  expect(got.headers.get('content-type')).toBe('image/png')
  expect(got.headers.get('x-content-type-options')).toBe('nosniff')
  expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG)
})

test('SVG, other files and empty bodies are refused; so is another site', async () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  expect((await upload(svg)).status).toBe(400)
  // a PNG's name on something else: its bytes say what it is
  expect((await upload(new TextEncoder().encode('PNG but not really'))).status).toBe(400)
  expect((await upload(new Uint8Array())).status).toBe(400)
  expect((await upload(PNG, 'https://evil.example')).status).toBe(403)
})

test('only a stored picture by its exact name comes out', async () => {
  for (const bad of ['../db.sqlite', '..%2Fdb.sqlite', 'x.svg', `${crypto.randomUUID()}.svg`, `${crypto.randomUUID()}.png/..`, `${crypto.randomUUID()}.png`]) {
    expect(noteImageFile(bad)).toBeNull()
    expect((await app.request(`/api/note-images/${bad}`)).status).toBe(404)
  }
})

test("a note keeps its own pictures only; agents read and write them as Markdown", () => {
  const own = `/api/note-images/${crypto.randomUUID()}.png`
  const html = `<p>a</p><img src="${own}" alt="foto"><img src="https://tracker.example/p.gif"><img src="data:image/png;base64,AAAA">`
  expect(keepOwnImages(html)).toBe(`<p>a</p><img src="${own}" alt="foto">`)
  expect(htmlToMarkdown(keepOwnImages(html))).toBe(`a\n\n![foto](${own})`)
  expect(markdownToHtml(`![foto](${own})`)).toBe(`<img src="${own}" alt="foto">`)
  // an agent can't point the note elsewhere
  expect(markdownToHtml('![x](https://tracker.example/p.gif)')).not.toContain('<img')
})

test("a picture's size and place survive; anything else on it doesn't", () => {
  const own = `/api/note-images/${crypto.randomUUID()}.jpg`
  expect(keepOwnImages(`<img src="${own}" alt="a" data-width="50%" style="width: 50%" data-align="center" onerror="alert(1)">`)).toBe(
    `<img src="${own}" alt="a" data-width="50%" style="width: 50%" data-align="center">`,
  )
  // only a plain width: no other style, no width out of range
  expect(keepOwnImages(`<img src="${own}" style="width: 40%; position: fixed; background: url(x)">`)).toBe(`<img src="${own}" data-width="40%" style="width: 40%">`)
  expect(keepOwnImages(`<img src="${own}" data-width="300%" style="width: expression(alert(1))">`)).toBe(`<img src="${own}">`)
  expect(keepOwnImages(`<img src="${own}" data-width="320px">`)).toBe(`<img src="${own}" data-width="320px" style="width: 320px">`)
})
