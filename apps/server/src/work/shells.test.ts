import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECTS_DIR } from '../fsroots'
import { tmux } from '../agents/tmux'
import { endShell, openShell, shellName, shellRunning, shellTarget } from './shells'

// A folder's terminal: one shell per folder in the agents' tmux server, kept until it's ended; only folders the
// Projects tab may show.

const folder = join(PROJECTS_DIR, 'sh-site')
mkdirSync(folder, { recursive: true })
afterAll(async () => {
  await endShell(folder).catch(() => {})
  rmSync(folder, { recursive: true, force: true })
})

test('opens one shell per folder (opening again keeps it), ends it; never outside the office folders', async () => {
  expect(shellName(folder)).toMatch(/^ao--sh-[0-9a-f]{12}$/)
  expect(await shellRunning(folder)).toBe(false)
  await expect(shellTarget(folder)).rejects.toThrow('Open the terminal first')
  const first = await openShell(folder)
  expect(first.started).toBe(true)
  expect(await tmux.hasSession(first.name)).toBe(true)
  expect((await openShell(folder)).started).toBe(false)
  expect(await shellTarget(folder)).toBe(first.name)
  await endShell(folder)
  expect(await shellRunning(folder)).toBe(false)
  await expect(openShell('/etc')).rejects.toThrow()
})
