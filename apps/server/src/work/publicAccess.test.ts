import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publicAccess, startPublicAccess, stopPublicAccess, watchPublicAccess } from './publicAccess'

// Public access: the dashboard only leaves a request; the root helper (deploy/after-office-access, faked here) answers
// in status.json with the request's id.
test('public access asks the root helper and waits for its answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ao-access-'))
  mkdirSync(join(dir, 'in'))
  mkdirSync(join(dir, 'out'))
  process.env.OFFICE_ACCESS_DIR = dir
  const status = (s: object) => writeFileSync(join(dir, 'out', 'status.json'), JSON.stringify({ supported: true, domain: 'office.example.com', public: false, since: null, until: null, id: null, reason: null, error: null, at: Date.now(), ...s }))
  // the fake helper: answers each request the way the real one does
  let reply: (req: string) => object = () => ({})
  const seen: string[] = []
  const helper = setInterval(() => {
    const f = join(dir, 'in', 'request')
    if (!existsSync(f)) return
    const req = readFileSync(f, 'utf8').trim()
    rmSync(f)
    seen.push(req)
    status({ id: req.split(' ').pop(), ...reply(req) })
  }, 50)
  try {
    // not set up: not offered
    expect(publicAccess()).toEqual({ supported: false, public: false })
    status({})
    expect(publicAccess()).toMatchObject({ supported: true, public: false, domain: 'office.example.com' })

    // limits are checked before anything is asked
    await expect(startPublicAccess(Date.now() + 30_000)).rejects.toThrow('between a minute and 7 days')
    await expect(startPublicAccess(Date.now() + 8 * 86_400_000)).rejects.toThrow('between a minute and 7 days')
    expect(seen).toEqual([])

    const until = Date.now() + 3_600_000
    reply = () => ({ public: true, since: Date.now(), until })
    expect(await startPublicAccess(until)).toMatchObject({ public: true, until })
    expect(seen[0]).toMatch(new RegExp(`^on ${until} [0-9a-f-]{36}$`))

    // the helper's error comes back as the request's error
    reply = () => ({ public: false, error: 'This server has no public IPv4 address' })
    await expect(startPublicAccess(until)).rejects.toThrow('no public IPv4')

    reply = () => ({ public: false, reason: 'owner' })
    expect(await stopPublicAccess()).toMatchObject({ public: false })
    expect(seen.at(-1)).toMatch(/^off [0-9a-f-]{36}$/)

    // the helper ended it on its own (time up): noticed on the next tick
    reply = () => ({ public: true, until })
    await startPublicAccess(until)
    status({ public: false, reason: 'expired' })
    watchPublicAccess()
    expect(publicAccess().public).toBe(false)
  } finally {
    clearInterval(helper)
    delete process.env.OFFICE_ACCESS_DIR
    rmSync(dir, { recursive: true, force: true })
  }
})

test('public access: no request folder, no switch', async () => {
  process.env.OFFICE_ACCESS_DIR = join(tmpdir(), 'ao-access-missing')
  try {
    await expect(stopPublicAccess()).rejects.toThrow('--tailscale --domain')
  } finally {
    delete process.env.OFFICE_ACCESS_DIR
  }
})
