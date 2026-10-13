import { afterAll, expect, test } from 'bun:test'
import { agentsRepo, settingsRepo, type AgentRow } from '../db'
import { imageToolInfo, putImageKey, removeImageKey, setImageAccess, toolsEnv } from './tools'

// The office's API keys (Tools → Image generation): one per provider (and custom ones), sealed, shown by their last 4
// characters, and handed to the sessions of the agents that may have them.

const agent = (id: string) => ({ id, name: id, tmux_session: `ao-${id}`, cwd: '/tmp', desk: Math.floor(Math.random() * 1e6), role: '', model: 'haiku', permission_mode: 'default', session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'worker' }) as AgentRow
agentsRepo.insert(agent('tl-a'))
agentsRepo.insert(agent('tl-b'))
afterAll(() => settingsRepo.delete('officeTools:image'))

test('saved sealed, shown by its last 4, handed to every agent by default', () => {
  putImageKey('google', { key: 'AIzaSyTEST-google-1234' })
  const info = imageToolInfo()
  expect(info.keys).toEqual([expect.objectContaining({ id: 'google', provider: 'google', env: 'GEMINI_API_KEY', enabled: true, last4: '1234' })])
  expect(JSON.stringify(info)).not.toContain('AIzaSy')
  expect(settingsRepo.get('officeTools:image')).not.toContain('AIzaSy')
  const env = toolsEnv('tl-a')
  expect(env.GEMINI_API_KEY).toBe('AIzaSyTEST-google-1234')
  expect(env.AO_IMAGE_PROVIDER).toBe('google')
  // what's set, without the keys
  expect(JSON.parse(env.AO_IMAGE_PROVIDERS)).toEqual([{ id: 'google', label: 'Google AI Studio', env: 'GEMINI_API_KEY', baseUrl: expect.any(String), model: 'gemini-2.5-flash-image' }])
  expect(env.AO_IMAGE_PROVIDERS).not.toContain('AIzaSy')
})

test('several providers at once; the preferred one first; off ones left out', () => {
  putImageKey('openrouter', { key: 'sk-or-v1-abcd' })
  putImageKey('replicate', { key: 'r8_token9999', model: 'black-forest-labs/flux-1.1-pro' })
  setImageAccess({ preferred: 'openrouter' })
  expect(toolsEnv('tl-a')).toMatchObject({ OPENROUTER_API_KEY: 'sk-or-v1-abcd', REPLICATE_API_TOKEN: 'r8_token9999', AO_IMAGE_PROVIDER: 'openrouter' })
  expect(imageToolInfo().keys.find((k) => k.id === 'replicate')?.model).toBe('black-forest-labs/flux-1.1-pro')
  // switched off (an empty key keeps it)
  putImageKey('openrouter', { enabled: false })
  expect(imageToolInfo().keys.find((k) => k.id === 'openrouter')).toMatchObject({ enabled: false, last4: 'abcd' })
  expect(toolsEnv('tl-a').OPENROUTER_API_KEY).toBeUndefined()
  expect(toolsEnv('tl-a').AO_IMAGE_PROVIDER).toBe('google')
})

test('a custom one: its own name and variable, never one of the office’s', () => {
  const info = putImageKey('custom', { key: 'my-own-key-5555', label: 'Studio X', env: 'studio_x_key', baseUrl: 'https://api.studiox.dev' })
  const custom = info.keys.find((k) => k.provider === 'custom')!
  expect(custom).toMatchObject({ label: 'Studio X', env: 'STUDIO_X_KEY', baseUrl: 'https://api.studiox.dev', last4: '5555' })
  expect(custom.id).toStartWith('custom-')
  expect(toolsEnv('tl-a').STUDIO_X_KEY).toBe('my-own-key-5555')
  // renamed, key kept
  putImageKey(custom.id, { label: 'Studio X v2' })
  expect(imageToolInfo().keys.find((k) => k.id === custom.id)).toMatchObject({ label: 'Studio X v2', last4: '5555' })
  expect(() => putImageKey('custom', { key: 'k', label: 'Bad', env: 'GEMINI_API_KEY' })).toThrow("office's own")
  expect(() => putImageKey('custom', { key: 'k', label: 'Bad', env: 'ANTHROPIC_API_KEY' })).toThrow("office's own")
  expect(() => putImageKey('custom', { key: 'k', label: 'Dup', env: 'STUDIO_X_KEY' })).toThrow('already')
  expect(() => putImageKey('custom', { key: 'k', label: 'Bad', env: 'has space' })).toThrow('capital letters')
  removeImageKey(custom.id)
  expect(toolsEnv('tl-a').STUDIO_X_KEY).toBeUndefined()
})

test('only the agents picked get them', () => {
  setImageAccess({ access: ['tl-a', 'nobody'] })
  expect(imageToolInfo().access).toEqual(['tl-a'])
  expect(toolsEnv('tl-a').GEMINI_API_KEY).toBeDefined()
  expect(toolsEnv('tl-b')).toEqual({})
  setImageAccess({ access: 'all' })
  expect(toolsEnv('tl-b').GEMINI_API_KEY).toBeDefined()
})

test('bad input refused; removed: gone from sessions', () => {
  expect(() => putImageKey('midjourney', { key: 'x' })).toThrow('Unknown provider')
  expect(() => putImageKey('fal', {})).toThrow('Paste the API key')
  expect(() => putImageKey('fal', { key: 'a b' })).toThrow('no spaces')
  for (const id of ['google', 'openrouter', 'replicate']) removeImageKey(id)
  expect(toolsEnv('tl-a')).toEqual({})
})
