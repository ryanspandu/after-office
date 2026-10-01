import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentsRepo, projectsRepo, queueRepo, tasksRepo } from '../db'
import { workRoutes } from '../routes/work'
import { startTask, taskFolder } from './work'
import { addFolder, addFolderFile, recentCommits, workspaces } from './workspaces'

// The Projects tab reads the agents' folders: a repo folder is one project; any other folder holds several.

const home = mkdtempSync(join(tmpdir(), 'ao-ws-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))
const git = (dir: string, ...a: string[]) => Bun.spawnSync(['git', '-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=Tester', ...a])

describe('workspaces', () => {
  test('folders, repos inside, git state; only agent folders can be read', async () => {
    const shop = join(home, 'shop')
    mkdirSync(shop)
    git(shop, 'init', '-q', '-b', 'main')
    writeFileSync(join(shop, 'a.txt'), '1')
    git(shop, 'add', '.')
    git(shop, 'commit', '-qm', 'First commit')
    writeFileSync(join(shop, 'b.txt'), 'new')
    mkdirSync(join(home, 'notes'))
    mkdirSync(join(home, '.hidden'))
    symlinkSync('/etc', join(home, 'etc-link'))
    agentsRepo.insert({ id: 'ws-a', name: 'WS', tmux_session: 'ao-ws', cwd: home, desk: 991, role: '', model: 'haiku', permission_mode: 'default', session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'worker' })

    const ws = (await workspaces(true)).find((w) => w.path === home)!
    expect(ws.git).toBeNull()
    expect(ws.agentIds).toEqual(['ws-a'])
    const names = ws.projects.map((p) => p.name).sort()
    expect(names).toEqual(['notes', 'shop'])
    const repo = ws.projects.find((p) => p.name === 'shop')!
    expect(repo.git).toMatchObject({ branch: 'main', dirty: 1, lastCommit: { subject: 'First commit' } })
    expect(ws.projects.find((p) => p.name === 'notes')!.git).toBeNull()

    expect((await recentCommits(shop))[0]).toMatchObject({ subject: 'First commit', author: 'Tester' })
    expect(recentCommits('/etc')).rejects.toThrow()
    expect(recentCommits(join(home, 'etc-link'))).rejects.toThrow()
    agentsRepo.remove('ws-a')
  })

  test('a project linked to a folder: the scan shows it, tasks are told to work there, checks run there', async () => {
    const shop = join(home, 'shop')
    agentsRepo.insert({ id: 'ws-b', name: 'WB', tmux_session: 'ao-wb', cwd: home, desk: 992, role: '', model: 'haiku', permission_mode: 'default', session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'worker' })
    projectsRepo.put({ id: 'ws-p', name: 'Shop', color: '#ff0000', folder: shop })
    const ws = (await workspaces(true)).find((w) => w.path === home)!
    expect(ws.projects.find((p) => p.name === 'shop')!.projectId).toBe('ws-p')

    tasksRepo.put({ id: 'ws-t', title: 'Fix cart', agentId: 'ws-b', projectId: 'ws-p', deadline: Date.now(), priority: 'low', status: 'todo' })
    expect(taskFolder(tasksRepo.get('ws-t')!)).toBe(shop)
    await startTask('ws-t')
    let prompt = ''
    for (let q = queueRepo.next('ws-b'); q; q = queueRepo.next('ws-b')) {
      prompt = q.text
      queueRepo.remove(q.id)
    }
    expect(prompt).toContain(`Folder: ${shop}`)
    agentsRepo.remove('ws-b')
  })

  test('a project folder must be one agents may use', async () => {
    const res = await workRoutes.request('/projects/ws-bad', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Bad', folder: '/etc' }) })
    expect(res.status).toBe(400)
  })
})

describe('project folders', () => {
  const put = (id: string, body: unknown) =>
    workRoutes.request(`/projects/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  test('a new project gets <agents dir>/project/<name>; a taken name gets a number', async () => {
    const { PROJECTS_DIR } = await import('../fsroots')
    expect(PROJECTS_DIR).toContain('after-office-test-home-') // never the real ~/after-office (test-setup.ts)
    const a = (await (await put('proj-seo', { name: 'SEO Research', createFolder: true })).json()) as { folder: string }
    expect(a.folder).toBe(join(PROJECTS_DIR, 'seo-research'))
    const b = (await (await put('proj-seo2', { name: 'SEO research', createFolder: true })).json()) as { folder: string }
    expect(b.folder).toBe(join(PROJECTS_DIR, 'seo-research-2'))
    // renaming keeps its folder
    await put('proj-seo', { name: 'SEO', folder: a.folder })
    expect(projectsRepo.get('proj-seo')).toMatchObject({ name: 'SEO', folder: a.folder })
    // and it's listed in the Projects tab, under the projects folder
    const shared = (await workspaces(true)).find((w) => w.shared)!
    expect(shared.path).toBe(PROJECTS_DIR)
    expect(shared.projects.map((p) => p.name).sort()).toEqual(['seo-research', 'seo-research-2'])
    expect(shared.projects.find((p) => p.name === 'seo-research')!.projectId).toBe('proj-seo')
  })

  test('deleting with ?folder=1 removes only a folder the office made', async () => {
    const folder = projectsRepo.get('proj-seo')!.folder!
    writeFileSync(join(folder, 'keywords.md'), '# kw')
    const info = (await (await workRoutes.request('/projects/proj-seo/folder')).json()) as { deletable: boolean; entries: number }
    expect(info).toMatchObject({ deletable: true, entries: 1 })
    expect((await workRoutes.request('/projects/proj-seo?folder=1', { method: 'DELETE' })).status).toBe(200)
    expect(projectsRepo.get('proj-seo')).toBeNull()
    expect(require('node:fs').existsSync(folder)).toBe(false)

    // a project on an agent's folder: the folder stays, and asking to delete it is refused
    const { AGENTS_DIR } = await import('../fsroots')
    const agentHome = join(AGENTS_DIR, 'nova')
    mkdirSync(agentHome)
    expect((await put('proj-agent', { name: 'Agent home', folder: agentHome })).status).toBe(200)
    expect((await (await workRoutes.request('/projects/proj-agent/folder')).json()) as { deletable: boolean }).toMatchObject({ deletable: false })
    expect((await workRoutes.request('/projects/proj-agent?folder=1', { method: 'DELETE' })).status).toBe(400)
    expect(projectsRepo.get('proj-agent')).not.toBeNull()
    expect(require('node:fs').existsSync(agentHome)).toBe(true)
  })
})

describe('file manager', () => {
  test('lists a folder (folders first, hidden left out) and serves its files; nothing outside', async () => {
    const { AGENTS_DIR } = await import('../fsroots')
    const root = join(AGENTS_DIR, 'fm-agent')
    mkdirSync(join(root, 'out', 'deep'), { recursive: true })
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, 'notes.md'), '# notes')
    writeFileSync(join(root, 'out', 'chart.png'), 'png')
    writeFileSync(join(root, '.claude', 'settings.local.json'), '{}')
    const secret = join(AGENTS_DIR, 'fm-secret.env')
    writeFileSync(secret, 'KEY=x')
    symlinkSync(secret, join(root, 'leak.env'))
    agentsRepo.insert({ id: 'fm-a', name: 'FM', tmux_session: 'ao-fm', cwd: root, desk: 993, role: '', model: 'haiku', permission_mode: 'default', session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'worker' })
    const q = (path: string, extra = '') => workRoutes.request(`${path}?root=${encodeURIComponent(root)}${extra}`)

    const top = (await (await q('/workspaces/files')).json()) as import('@after-office/shared').FolderListing
    expect(top.entries.map((e) => e.name)).toEqual(['out', 'leak.env', 'notes.md'])
    expect(top.entries[0].dir).toBe(true)
    expect(top.entries.find((e) => e.name === 'leak.env')!.link).toBe(true)
    const out = (await (await q('/workspaces/files', '&path=out')).json()) as import('@after-office/shared').FolderListing
    expect(out.path).toBe('out')
    expect(out.entries.map((e) => [e.name, !!e.image])).toEqual([['deep', false], ['chart.png', true]])

    const file = await q('/workspaces/file', '&path=notes.md')
    expect(file.status).toBe(200)
    expect(await file.text()).toBe('# notes')
    expect(file.headers.get('content-security-policy')).toContain('sandbox')
    // out of bounds: parent folders, symlinks, hidden files are listed nowhere and served never
    expect((await q('/workspaces/files', '&path=..')).status).toBe(403)
    expect((await q('/workspaces/file', '&path=../fm-secret.env')).status).toBe(403)
    expect((await q('/workspaces/file', '&path=leak.env')).status).toBe(403)
    expect((await workRoutes.request(`/workspaces/files?root=${encodeURIComponent(AGENTS_DIR)}`)).status).toBe(403)
    agentsRepo.remove('fm-a')
  })

  test('uploads a new file into the folder on screen: inside it only, plain names, never over a file', async () => {
    const { AGENTS_DIR } = await import('../fsroots')
    const root = join(AGENTS_DIR, 'up-agent')
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(AGENTS_DIR, 'up-outside.md'), 'x')
    symlinkSync(AGENTS_DIR, join(root, 'out'))
    agentsRepo.insert({ id: 'up-a', name: 'UP', tmux_session: 'ao-up', cwd: root, desk: 994, role: '', model: 'haiku', permission_mode: 'default', session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'worker' })
    const bytes = new TextEncoder().encode('# brief')
    expect(addFolderFile(root, '', 'brief.md', bytes)).toEqual({ name: 'brief.md', size: bytes.byteLength })
    expect(readFileSync(join(root, 'brief.md'), 'utf8')).toBe('# brief')
    // a name with a path in it lands in the folder on screen, as its last part
    expect(addFolderFile(root, 'docs', '../../evil/notes.md', bytes).name).toBe('notes.md')
    expect(readFileSync(join(root, 'docs', 'notes.md'), 'utf8')).toBe('# brief')
    expect(() => addFolderFile(root, '', 'brief.md', bytes)).toThrow('already there')
    expect(() => addFolderFile(root, '', '.env', bytes)).toThrow('normal name')
    expect(() => addFolderFile(root, '', 'empty.md', new Uint8Array())).toThrow('empty')
    expect(() => addFolderFile(root, '..', 'x.md', bytes)).toThrow('Invalid folder')
    expect(() => addFolderFile(root, 'out', 'x.md', bytes)).toThrow('Outside')
    expect(() => addFolderFile(AGENTS_DIR, '', 'x.md', bytes)).toThrow()
    agentsRepo.remove('up-a')
  })

  test('makes a new folder in the folder on screen: plain names, inside it only, never over anything', async () => {
    const { AGENTS_DIR } = await import('../fsroots')
    const root = join(AGENTS_DIR, 'nf-agent')
    mkdirSync(join(root, 'docs'), { recursive: true })
    agentsRepo.insert({ id: 'nf-a', name: 'NF', tmux_session: 'ao-nf', cwd: root, desk: 995, role: '', model: 'haiku', permission_mode: 'default', session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'worker' })
    expect(addFolder(root, '', ' drafts ')).toEqual({ name: 'drafts' })
    expect(statSync(join(root, 'drafts')).isDirectory()).toBe(true)
    expect(addFolder(root, 'docs', 'old').name).toBe('old')
    expect(statSync(join(root, 'docs', 'old')).isDirectory()).toBe(true)
    expect(() => addFolder(root, '', 'drafts')).toThrow('already there')
    expect(() => addFolder(root, '', '.hidden')).toThrow('plain name')
    expect(() => addFolder(root, '', 'a/b')).toThrow('plain name')
    expect(() => addFolder(root, '..', 'x')).toThrow('Invalid folder')
    agentsRepo.remove('nf-a')
  })
})

describe('bulk download', () => {
  test('picked files and folders come as one valid ZIP; hidden files, links and outside paths never', async () => {
    const { AGENTS_DIR } = await import('../fsroots')
    const root = join(AGENTS_DIR, 'zip-agent')
    mkdirSync(join(root, 'out', '.cache'), { recursive: true })
    writeFileSync(join(root, 'a.md'), '# a')
    writeFileSync(join(root, 'out', 'b.csv'), 'x,y')
    writeFileSync(join(root, 'out', '.cache', 'secret'), 'no')
    writeFileSync(join(root, 'riset ñ.md'), 'utf8 name')
    agentsRepo.insert({ id: 'zip-a', name: 'ZIP', tmux_session: 'ao-zip', cwd: root, desk: 992, role: '', model: 'haiku', permission_mode: 'default', session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'worker' })
    const post = (paths: string[]) =>
      workRoutes.request('/workspaces/zip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root, paths }) })

    const r = await post(['a.md', 'out', 'riset ñ.md'])
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/zip')
    const file = join(home, 'test.zip')
    writeFileSync(file, new Uint8Array(await r.arrayBuffer()))
    // read back with Python's zipfile (honours the UTF-8 flag; testzip() checks every CRC)
    const py = Bun.spawnSync(['python3', '-c', 'import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps([sorted(z.namelist()), z.testzip()]))', file])
    if (py.exitCode === 0) expect(JSON.parse(py.stdout.toString())).toEqual([['a.md', 'out/b.csv', 'riset ñ.md'], null])
    expect((await post(['../zip-outside'])).status).toBe(403)
    expect((await post(['out/.cache/secret'])).status).toBe(403)
    expect((await post([])).status).toBe(400)
    agentsRepo.remove('zip-a')
  })
})

describe("a report's attachments", () => {
  test('still open after the agent is removed; "no longer exists" once the file is gone; nothing unlisted', async () => {
    const { reportsRepo } = await import('../db')
    const { AGENTS_DIR } = await import('../fsroots')
    const { unlinkSync } = await import('node:fs')
    const dir = join(AGENTS_DIR, 'gone-agent')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'kw.md')
    writeFileSync(file, '# kw')
    writeFileSync(join(dir, 'other.md'), 'not attached')
    // the agent is already gone: only the report remains
    reportsRepo.put({ id: 'rep-gone', kind: 'task', refId: 't', title: 'KW', agentId: 'removed-agent', text: 'done', ok: true, startedAt: 1, finishedAt: 2, read: false, files: [{ path: file, size: 4 }] })
    const get = (path: string) => workRoutes.request(`/reports/rep-gone/file?path=${encodeURIComponent(path)}`)

    expect(await (await workRoutes.request('/reports/rep-gone/files')).json()).toEqual([{ path: file, size: 4 }])
    const r = await get(file)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('# kw')
    expect((await get(join(dir, 'other.md'))).status).toBe(404) // not one of its attachments

    unlinkSync(file)
    expect(await (await workRoutes.request('/reports/rep-gone/files')).json()).toEqual([{ path: file, size: 4, missing: true }])
    const gone = await get(file)
    expect(gone.status).toBe(404)
    expect(((await gone.json()) as { error: string }).error).toBe('This file no longer exists')
    reportsRepo.remove('rep-gone')
  })
})

describe('renaming a project folder', () => {
  test('only folders in the projects folder; the linked project follows; never over another folder', async () => {
    const { PROJECTS_DIR } = await import('../fsroots')
    const { renameProjectFolder } = await import('./projectFolders')
    mkdirSync(join(PROJECTS_DIR, 'rn-old'), { recursive: true })
    mkdirSync(join(PROJECTS_DIR, 'rn-taken'), { recursive: true })
    projectsRepo.put({ id: 'rn-p', name: 'rn-old', color: '#f07a1d', folder: join(PROJECTS_DIR, 'rn-old') })
    expect(() => renameProjectFolder(join(PROJECTS_DIR, 'rn-old'), 'rn-taken')).toThrow('already a folder')
    expect(() => renameProjectFolder(join(PROJECTS_DIR, 'rn-old'), '!!!')).toThrow('Give it a name')
    expect(() => renameProjectFolder(home, 'x')).toThrow('Only folders in the projects folder')
    const r = renameProjectFolder(join(PROJECTS_DIR, 'rn-old'), 'Static Bloom')
    expect(r.folder).toBe(join(PROJECTS_DIR, 'static-bloom'))
    expect(statSync(r.folder).isDirectory()).toBe(true)
    expect(projectsRepo.get('rn-p')).toMatchObject({ name: 'static-bloom', folder: r.folder })
    projectsRepo.remove('rn-p')
    rmSync(r.folder, { recursive: true, force: true })
    rmSync(join(PROJECTS_DIR, 'rn-taken'), { recursive: true, force: true })
  })
})

describe('folders without an agent', () => {
  test('listed as orphans, browsable, deletable; agent and project folders are not', async () => {
    const { AGENTS_DIR, PROJECTS_DIR } = await import('../fsroots')
    const { existsSync } = await import('node:fs')
    const orphan = join(AGENTS_DIR, 'old-sari')
    mkdirSync(join(orphan, 'out'), { recursive: true })
    writeFileSync(join(orphan, 'kw.md'), '# kw')
    const live = join(AGENTS_DIR, 'live-agent')
    mkdirSync(live, { recursive: true })
    agentsRepo.insert({ id: 'orph-live', name: 'Live', tmux_session: 'ao-orph-live', cwd: live, desk: 990, role: '', model: 'haiku', permission_mode: 'default', session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'worker' })

    const ws = await workspaces(true)
    const entry = ws.find((w) => w.path === orphan)!
    expect(entry).toMatchObject({ orphan: true, agentIds: [] })
    expect(ws.some((w) => w.path === live && w.orphan)).toBe(false)
    expect(ws.some((w) => w.path === PROJECTS_DIR && w.orphan)).toBe(false)

    // its files can still be looked at
    const list = (await (await workRoutes.request(`/workspaces/files?root=${encodeURIComponent(orphan)}`)).json()) as { entries: { name: string }[] }
    expect(list.entries.map((e) => e.name)).toEqual(['out', 'kw.md'])

    const del = (path: string) => workRoutes.request(`/workspaces/folder?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
    expect((await del(live)).status).toBe(403)
    expect((await del(PROJECTS_DIR)).status).toBe(403)
    expect((await del(join(AGENTS_DIR, '..'))).status).toBe(403)
    expect((await del(orphan)).status).toBe(200)
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(live)).toBe(true)
    agentsRepo.remove('orph-live')
  })
})

describe('reports: view all', () => {
  test('date range, search, filter and pages over every stored report', async () => {
    const { reportsRepo } = await import('../db')
    const day = 86_400_000
    const base = Date.parse('2020-03-01T12:00:00Z') // apart from the other tests' reports (made "now")
    for (let i = 0; i < 30; i++)
      reportsRepo.put({ id: `va-${i}`, kind: i % 3 ? 'task' : 'cron', refId: 'x', title: i === 7 ? 'Keyword riset bola' : `Report ${i}`, agentId: 'nobody', text: 'done', ok: i !== 5, startedAt: base + i * day, finishedAt: base + i * day, read: i > 2 })
    type Page = { items: { id: string }[]; total: number; page: number; pages: number }
    const get = async (q: string) => (await (await workRoutes.request(`/reports?${q}`)).json()) as Page

    const all = await get(`from=${base}&to=${base + 29 * day}&per=10`)
    expect(all).toMatchObject({ total: 30, page: 1, pages: 3 })
    expect(all.items[0].id).toBe('va-29') // newest first
    expect((await get(`from=${base}&to=${base + 29 * day}&per=10&page=3`)).items.map((r) => r.id).at(-1)).toBe('va-0')
    expect((await get(`from=${base + 10 * day}&to=${base + 12 * day}`)).total).toBe(3)
    expect((await get(`q=BOLA&from=${base}&to=${base + 29 * day}`)).items.map((r) => r.id)).toEqual(["va-7"])
    expect((await get(`filter=failed&from=${base}&to=${base + 29 * day}`)).items.map((r) => r.id)).toEqual(['va-5'])
    expect((await get(`filter=cron&from=${base}&to=${base + 29 * day}`)).total).toBe(10)
    expect((await get(`per=10&page=99&from=${base}&to=${base + 29 * day}`)).page).toBe(3) // clamped
    for (let i = 0; i < 30; i++) reportsRepo.remove(`va-${i}`)
  })
})

describe('reports by project', () => {
  test("the manager's notes and task reports carry their project; the view can filter by it", async () => {
    const { reportsRepo } = await import('../db')
    const { notifyUser } = await import('./work')
    projectsRepo.put({ id: 'rp-seo', name: 'SEO', color: '#e8762c' })
    const note = notifyUser('some-manager', 'SEO week', 'Done: 3 articles', 'rp-seo')
    expect(note.projectId).toBe('rp-seo')
    const plain = notifyUser('some-manager', 'Other', 'Nothing to do with SEO')
    expect(plain.projectId).toBeUndefined()
    const get = async (q: string) => ((await (await workRoutes.request(`/reports?${q}`)).json()) as { items: { id: string }[] }).items.map((r) => r.id)
    expect(await get('project=rp-seo')).toEqual([note.id])
    expect(await get('project=none&q=Nothing')).toEqual([plain.id])
    reportsRepo.remove(note.id)
    reportsRepo.remove(plain.id)
    projectsRepo.remove('rp-seo')
  })
})
