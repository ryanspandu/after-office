import { expect, test } from 'bun:test'
import { stopPort } from '../work/previews'
import { endTerminal, runningReport } from './running'
import { toolsReport } from './tools'

// The Server window: what can be stopped from it is limited (never a system port, never the dashboard), terminals are
// ended by their own name only, and the reports have their shape.

test('stopping a port: never a system port or the dashboard', async () => {
  await expect(stopPort(22)).rejects.toThrow('cannot be stopped')
  await expect(stopPort(80)).rejects.toThrow('cannot be stopped')
  await expect(stopPort(Number(process.env.OFFICE_PORT ?? process.env.PORT ?? 8787))).rejects.toThrow('cannot be stopped')
  await expect(stopPort(70000)).rejects.toThrow('cannot be stopped')
  // nothing listening: nothing to do
  expect(await stopPort(45991)).toEqual({ stopped: true })
})

test('a terminal is ended by its own kind of name only', async () => {
  await expect(endTerminal('ao-marcus')).rejects.toThrow('Not a terminal')
  await expect(endTerminal('ao--sh-../../x')).rejects.toThrow('Not a terminal')
  expect(await endTerminal('ao--sh-000000000000')).toEqual({ ended: true })
})

test('the reports have their shape (whatever this machine has installed)', async () => {
  const r = await runningReport()
  expect(Array.isArray(r.sessions) && Array.isArray(r.terminals) && Array.isArray(r.services)).toBe(true)
  const t = await toolsReport()
  const git = t.tools.find((x) => x.id === 'git')!
  expect(git.installed).toBe(true)
  expect(git.auth).toBe('na')
  // a tool that isn't installed shows how to install it, and never claims a login
  for (const x of t.tools.filter((x) => !x.installed)) {
    expect(x.install.length).toBeGreaterThan(3)
    expect(x.auth).toBe('na')
  }
}, 120_000)
