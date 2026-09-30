import { expect, test } from 'bun:test'
import { createECDH, randomBytes } from 'node:crypto'
import { settingsRepo } from './db'
import { addPushDevice, pushDevices, pushPublicKey, sendPush } from './push'
import { channelNames } from './notify'

// Web Push: devices subscribe with the server's key; sending goes to the browser push service, encrypted; a
// subscription the service says is gone is dropped.
const sub = (host = 'fcm.googleapis.com') => {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { endpoint: `https://${host}/fcm/send/${randomBytes(8).toString('hex')}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
}

test('web push devices', async () => {
  process.env.SESSION_SECRET ??= 'x'.repeat(40)
  settingsRepo.delete('webPushSubs')
  expect(pushPublicKey()).toMatch(/^[\w-]{80,}$/)
  // only real push services, only complete subscriptions
  expect(() => addPushDevice(sub('evil.example.com'), 'x')).toThrow('push subscription')
  expect(() => addPushDevice({ endpoint: 'https://fcm.googleapis.com/x', keys: {} }, 'x')).toThrow('Incomplete')
  const a = sub()
  const id = addPushDevice(a, 'Chrome on Android')
  expect(pushDevices()).toEqual([{ id, label: 'Chrome on Android', createdAt: expect.any(Number) }])
  expect(JSON.stringify(pushDevices())).not.toContain(a.keys.auth)
  expect(channelNames()).toContain('this app (1 device)')

  const real = globalThis.fetch
  const seen: { url: string; headers: Record<string, string>; bytes: number }[] = []
  let status = 201
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, bytes: (init.body as Uint8Array).length })
    return new Response('', { status })
  }) as typeof fetch
  try {
    const ok = await sendPush({ title: 'Hi', body: 'secret text', url: '/?open=attention' })
    expect(ok).toEqual([{ device: 'Chrome on Android', ok: true }])
    expect(seen[0].url).toBe(a.endpoint)
    expect(seen[0].headers['Content-Encoding']).toBe('aes128gcm')
    expect(seen[0].headers.Authorization).toStartWith('vapid ')
    expect(pushDevices()[0].lastOkAt).toBeNumber()
    // gone at the push service: dropped
    status = 410
    await sendPush({ title: 'Hi', body: 'x' })
    expect(pushDevices()).toEqual([])
  } finally {
    globalThis.fetch = real
  }
})
