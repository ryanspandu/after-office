import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { agentsRepo, extraDirsOf, queueRepo, tasksRepo } from '../db'
import { PROJECT_DIR } from '../fsroots'
import { startTask } from '../work/work'
import { grantFolder } from './manager'

// One agent, many folders: a task in a folder outside the agent's own folder gives the agent that folder.

const scratch = mkdtempSync(join(dirname(PROJECT_DIR), 'ao-dirs-test-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('folders outside the agent', () => {
  test('a task there grants the folder (once); its own folder and folders outside the roots are never added', async () => {
    const home = join(scratch, 'agents', 'ava')
    const web = join(scratch, 'projects', 'web')
    mkdirSync(home, { recursive: true })
    mkdirSync(web, { recursive: true })
    agentsRepo.insert({ id: 'dirs-a', name: 'Ava', tmux_session: 'ao-dirs-a', cwd: home, desk: 993, role: 'Fullstack', model: 'haiku', permission_mode: 'default', session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'worker' })
    tasksRepo.put({ id: 'dirs-t', title: 'Landing page', agentId: 'dirs-a', folder: web, deadline: Date.now(), priority: 'low', status: 'todo' })

    await startTask('dirs-t') // no tmux session here: queued; the folder is granted when it's actually sent
    for (let q = queueRepo.next('dirs-a'); q; q = queueRepo.next('dirs-a')) queueRepo.remove(q.id)
    await grantFolder('dirs-a', web)
    await grantFolder('dirs-a', web)
    await grantFolder('dirs-a', join(home, 'sub'))
    expect(extraDirsOf(agentsRepo.get('dirs-a'))).toEqual([web])
    await expect(grantFolder('dirs-a', '/etc')).rejects.toThrow('Folder must be inside')
    agentsRepo.remove('dirs-a')
  })
})
