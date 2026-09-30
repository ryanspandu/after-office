import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { mentionedPaths } from '@after-office/shared'
import { agentsRepo } from '../db'
import { PROJECT_DIR } from '../fsroots'
import { agentRoutes } from '../routes/agents'
import { agentFiles } from './files'

// Attachments: only files inside the agent's folders, no symlinks, served so they can't run in the page.

const scratch = mkdtempSync(join(dirname(PROJECT_DIR), 'ao-files-test-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('agent files', () => {
  const home = join(scratch, 'agent')
  const outside = join(scratch, 'secret.env')
  mkdirSync(join(home, 'out'), { recursive: true })
  writeFileSync(join(home, 'out', 'chart.png'), 'png')
  writeFileSync(join(home, 'notes.md'), '# hi')
  writeFileSync(join(home, 'page.svg'), '<svg onload="alert(1)"/>')
  writeFileSync(outside, 'SESSION_SECRET=x')
  symlinkSync(outside, join(home, 'link.env'))
  agentsRepo.insert({ id: 'files-a', name: 'Fa', tmux_session: 'ao-files-a', cwd: home, desk: 994, role: '', model: 'haiku', permission_mode: 'default', session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'worker' })
  const row = () => agentsRepo.get('files-a')!

  test('paths in text, then only real files in the agent folder', () => {
    const text = `Chart: ${home}/out/chart.png. Notes in \`notes.md\`, secrets at ${outside} and ${home}/link.env, **${home}/page.svg**`
    const found = agentFiles(row(), mentionedPaths(text))
    expect(found.map((f) => f.path.split('/').pop()).sort()).toEqual(['chart.png', 'notes.md', 'page.svg'])
    expect(found.find((f) => f.path.endsWith('chart.png'))!.image).toBe(true)
  })

  test('download: allowed file served as untrusted; outside, symlinked or missing files refused', async () => {
    const app = new Hono().route('/api', agentRoutes)
    const get = (p: string, inline = false) => app.request(`/api/agents/files-a/file?path=${encodeURIComponent(p)}${inline ? '&inline=1' : ''}`)
    const ok = await get(join(home, 'notes.md'))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-disposition')).toStartWith('attachment')
    expect(ok.headers.get('content-security-policy')).toContain('sandbox')
    expect(await ok.text()).toBe('# hi')
    expect((await get(join(home, 'out', 'chart.png'), true)).headers.get('content-disposition')).toStartWith('inline')
    expect((await get(join(home, 'notes.md'), true)).headers.get('content-disposition')).toStartWith('attachment') // not an image
    expect((await get(outside)).status).toBe(404)
    expect((await get(join(home, 'link.env'))).status).toBe(404)
    expect((await get(join(home, '..', 'secret.env'))).status).toBe(404)
    expect((await get(join(home, 'nope.txt'))).status).toBe(404)
    agentsRepo.remove('files-a')
  })
})

describe("the manager's files", () => {
  test("the manager's reports can attach its team's files; a worker can't reach another's", async () => {
    const { notifyUser } = await import('../work/work')
    const row = (id: string, kind: 'worker' | 'manager', cwd: string) => ({
      id, name: id, tmux_session: `ao-${id}`, cwd, desk: Math.floor(Math.random() * 1e6), role: '', model: 'haiku',
      permission_mode: 'default' as const, session_id: crypto.randomUUID(), created_at: Date.now(), kind,
    })
    const team = join(scratch, 'team')
    for (const d of ['boss', 'sari', 'rio']) mkdirSync(join(team, d), { recursive: true })
    writeFileSync(join(team, 'sari', 'keywords.md'), '# kw')
    agentsRepo.insert(row('mf-boss', 'manager', join(team, 'boss')))
    agentsRepo.insert(row('mf-sari', 'worker', join(team, 'sari')))
    agentsRepo.insert(row('mf-rio', 'worker', join(team, 'rio')))
    const file = join(team, 'sari', 'keywords.md')

    expect(agentFiles(agentsRepo.get('mf-boss')!, [file])).toEqual([{ path: file, size: 4 }])
    expect(agentFiles(agentsRepo.get('mf-rio')!, [file])).toEqual([])
    const note = notifyUser('mf-boss', 'Keyword research done', `Sari finished. File: ${file}`)
    expect(note.files).toEqual([{ path: file, size: 4 }])
    for (const id of ['mf-boss', 'mf-sari', 'mf-rio']) agentsRepo.remove(id)
  })
})

describe("removing an agent with its folder", () => {
  test('only its own folder in the agents folder can go, and only when asked', async () => {
    const { AGENTS_DIR } = await import('../fsroots')
    const { existsSync } = await import('node:fs')
    const app = new Hono().route('/api', agentRoutes)
    const row = (id: string, cwd: string) => ({
      id, name: id, tmux_session: `ao-${id}`, cwd, desk: Math.floor(Math.random() * 1e6), role: '', model: 'haiku',
      permission_mode: 'default' as const, session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'worker' as const,
    })
    const own = join(AGENTS_DIR, 'rm-own')
    mkdirSync(join(own, 'out'), { recursive: true })
    writeFileSync(join(own, 'out', 'a.md'), 'a')
    const repo = join(scratch, 'some-repo') // a folder elsewhere (e.g. a repo): never deleted from here
    mkdirSync(repo, { recursive: true })
    const shared = join(AGENTS_DIR, 'rm-shared')
    mkdirSync(shared, { recursive: true })
    agentsRepo.insert(row('rm-own', own))
    agentsRepo.insert(row('rm-repo', repo))
    agentsRepo.insert(row('rm-s1', shared))
    agentsRepo.insert(row('rm-s2', shared))
    const info = async (id: string) => (await (await app.request(`/api/agents/${id}/folder`)).json()) as { deletable: boolean; entries: number }

    expect(await info('rm-own')).toMatchObject({ deletable: true, entries: 2 })
    expect(await info('rm-repo')).toMatchObject({ deletable: false })
    expect(await info('rm-s1')).toMatchObject({ deletable: false }) // someone else works there too

    expect((await app.request('/api/agents/rm-repo?folder=1', { method: 'DELETE' })).status).toBe(400)
    expect(agentsRepo.get('rm-repo')).not.toBeNull() // refused before anything happened
    expect((await app.request('/api/agents/rm-repo', { method: 'DELETE' })).status).toBe(200)
    expect(existsSync(repo)).toBe(true)

    expect((await app.request('/api/agents/rm-own?folder=1', { method: 'DELETE' })).status).toBe(200)
    expect(agentsRepo.get('rm-own')).toBeNull()
    expect(existsSync(own)).toBe(false)
    for (const id of ['rm-s1', 'rm-s2']) agentsRepo.remove(id)
  })
})
