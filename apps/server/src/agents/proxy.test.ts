import { afterAll, expect, test } from 'bun:test'
import { settingsRepo } from '../db'
import { proxyEnv, proxyInfo, proxyUrl, putProxy, removeProxy } from './proxy'
import { putSecret } from './secrets'

// The office's residential proxy: saved with its password sealed, shown without it, and handed to the agents' sessions
// as RESIDENTIAL_PROXY_* (never HTTP(S)_PROXY).

afterAll(() => removeProxy())

test('saved, shown without its password, handed to sessions', () => {
  putProxy({ provider: 'dataimpulse', protocol: 'http', host: 'gw.dataimpulse.com', port: 823, username: 'abc__cr.us', password: 'p@ss:word' })
  const info = proxyInfo()!
  expect(info).toMatchObject({ enabled: true, provider: 'dataimpulse', host: 'gw.dataimpulse.com', port: 823, username: 'abc__cr.us', hasPassword: true })
  expect(JSON.stringify(info)).not.toContain('p@ss')
  // stored sealed
  expect(settingsRepo.get('residentialProxy')).not.toContain('p@ss')
  // credentials encoded in the URL
  expect(proxyUrl()).toBe('http://abc__cr.us:p%40ss%3Aword@gw.dataimpulse.com:823')
  const env = proxyEnv()
  expect(env.RESIDENTIAL_PROXY_URL).toBe(proxyUrl()!)
  expect(env.RESIDENTIAL_PROXY_PASSWORD).toBe('p@ss:word')
  expect(env.HTTP_PROXY).toBeUndefined()
  expect(env.HTTPS_PROXY).toBeUndefined()
})

test('an empty password keeps the saved one; socks5; off = nothing for sessions', () => {
  putProxy({ provider: 'dataimpulse', protocol: 'socks5', host: 'gw.dataimpulse.com', port: 824, username: 'abc', password: '' })
  expect(proxyUrl()).toBe('socks5h://abc:p%40ss%3Aword@gw.dataimpulse.com:824')
  putProxy({ enabled: false, host: 'gw.dataimpulse.com', port: 824, username: 'abc' })
  expect(proxyInfo()!.enabled).toBe(false)
  expect(proxyEnv()).toEqual({})
})

test('bad input refused; its names are the office’s, not an agent secret’s', () => {
  expect(() => putProxy({ host: 'not a host', port: 80 })).toThrow('host')
  expect(() => putProxy({ host: 'gw.example.com', port: 70000 })).toThrow('port')
  expect(() => putProxy({ host: 'gw.example.com', port: 80, username: 'x', password: 'a\nb' })).toThrow('one line')
  expect(() => putSecret('nobody', 'RESIDENTIAL_PROXY_URL', 'x')).toThrow('office')
  removeProxy()
  expect(proxyInfo()).toBeNull()
})
