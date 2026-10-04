import { expect, test } from 'bun:test'
import { settingsRepo } from '../db'
import { dropSecrets, listSecrets, putSecret, removeSecret, secretEnv } from './secrets'

// An agent's secrets: stored sealed, listed without their values, given to its sessions as environment variables;
// the office's own variables can't be overridden.

process.env.SESSION_SECRET ??= 'test-secret-'.padEnd(40, 'x')

test('add, list (no values), env, replace, remove', () => {
  const info = putSecret('sec-a', 'expo_token', '  abcd-1234-WXYZ  ')
  expect(info).toMatchObject({ name: 'EXPO_TOKEN', last4: 'WXYZ' })
  putSecret('sec-a', 'RAILWAY_TOKEN', 'rail-9999')
  expect(listSecrets('sec-a').map((s) => s.name)).toEqual(['EXPO_TOKEN', 'RAILWAY_TOKEN'])
  expect(JSON.stringify(listSecrets('sec-a'))).not.toContain('abcd-1234')
  // stored sealed, not as typed
  expect(settingsRepo.get('agentSecrets:sec-a')).not.toContain('abcd-1234')
  expect(secretEnv('sec-a')).toEqual({ EXPO_TOKEN: 'abcd-1234-WXYZ', RAILWAY_TOKEN: 'rail-9999' })
  putSecret('sec-a', 'EXPO_TOKEN', 'new-value-0000')
  expect(secretEnv('sec-a').EXPO_TOKEN).toBe('new-value-0000')
  expect(listSecrets('sec-a')).toHaveLength(2)
  removeSecret('sec-a', 'RAILWAY_TOKEN')
  expect(Object.keys(secretEnv('sec-a'))).toEqual(['EXPO_TOKEN'])
  dropSecrets('sec-a')
  expect(listSecrets('sec-a')).toEqual([])
})

test('names: plain env names only, never the office’s own', () => {
  for (const bad of ['ANTHROPIC_API_KEY', 'AO_HOOK_TOKEN', 'PATH', 'CLAUDE_CONFIG_DIR', 'GIT_SSH_COMMAND', 'LD_PRELOAD']) expect(() => putSecret('sec-b', bad, 'x')).toThrow()
  for (const bad of ['1ABC', 'has space', 'a-b', '']) expect(() => putSecret('sec-b', bad, 'x')).toThrow()
  expect(() => putSecret('sec-b', 'OK_NAME', '')).toThrow('Paste the value')
  expect(() => putSecret('sec-b', 'OK_NAME', 'two\nlines')).toThrow()
  expect(() => removeSecret('sec-b', 'NOPE')).toThrow('No such secret')
})
