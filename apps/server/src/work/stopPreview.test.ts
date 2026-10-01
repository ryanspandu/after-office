import { afterAll, expect, test } from 'bun:test'
import { stopPreview } from './previews'

// Stopping an app on a preview port: the process listening there goes, and only preview ports can be stopped. (A port
// of its own, far from 3000–3009, so a real app on this machine is never touched.)

const PORT = 38_991
const before = process.env.OFFICE_PREVIEW_PORTS
process.env.OFFICE_PREVIEW_PORTS = String(PORT)
afterAll(() => {
  if (before === undefined) delete process.env.OFFICE_PREVIEW_PORTS
  else process.env.OFFICE_PREVIEW_PORTS = before
})

test('stops the app listening on a preview port; refuses other ports', async () => {
  const app = Bun.spawn(['bun', '-e', `Bun.serve({ port: ${PORT}, hostname: '127.0.0.1', fetch: () => new Response('hi') }); setInterval(() => {}, 1000)`], { stdout: 'ignore', stderr: 'ignore' })
  for (let i = 0; i < 40; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/`).then(() => true, () => false)) break
    await Bun.sleep(100)
  }
  expect(await stopPreview(PORT)).toEqual({ stopped: true })
  await app.exited
  expect(await fetch(`http://127.0.0.1:${PORT}/`).then(() => true, () => false)).toBe(false)
  // nothing running there any more: fine, nothing to do
  expect(await stopPreview(PORT)).toEqual({ stopped: true })
  await expect(stopPreview(8787)).rejects.toThrow('Not a preview port')
}, 15_000)
