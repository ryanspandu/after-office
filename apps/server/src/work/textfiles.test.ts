import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECTS_DIR } from '../fsroots'
import { listFolder, readTextFile, writeTextFile } from './workspaces'

// The Files browser's editor: text files read and saved in place; a save over a newer version is refused (unless
// forced); the office's own files (hooks, MCP, git) read only; hidden files listed only when asked.

const root = join(PROJECTS_DIR, 'editor-test')
mkdirSync(join(root, '.claude'), { recursive: true })
mkdirSync(join(root, '.git'), { recursive: true })
writeFileSync(join(root, 'notes.md'), '# Hello\n')
writeFileSync(join(root, '.env'), 'API_URL=http://x\n')
writeFileSync(join(root, '.mcp.json'), '{}\n')
writeFileSync(join(root, '.claude', 'settings.local.json'), '{}\n')
writeFileSync(join(root, '.git', 'config'), '[core]\n')
writeFileSync(join(root, 'logo.bin'), Buffer.from([0x89, 0x50, 0, 0, 1, 2]))

test('read, save, and a save over a newer version', () => {
  const f = readTextFile(root, 'notes.md')
  expect(f.text).toBe('# Hello\n')
  expect(f.editable).toBe(true)
  const saved = writeTextFile(root, 'notes.md', '# Hello\nworld\n', f.updatedAt)
  expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('# Hello\nworld\n')
  // an agent writes it meanwhile: the old version's save is refused; forced, it goes through
  writeFileSync(join(root, 'notes.md'), 'agent was here\n')
  utimesSync(join(root, 'notes.md'), new Date(), new Date(saved.updatedAt + 5000))
  expect(() => writeTextFile(root, 'notes.md', 'mine', saved.updatedAt)).toThrow('changed since you opened it')
  writeTextFile(root, 'notes.md', 'mine', saved.updatedAt, true)
  expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('mine')
})

test('hidden files: edited like the rest; the office’s own and git’s read only; binaries refused', () => {
  expect(readTextFile(root, '.env').editable).toBe(true)
  writeTextFile(root, '.env', 'API_URL=http://y\n')
  expect(readFileSync(join(root, '.env'), 'utf8')).toBe('API_URL=http://y\n')
  for (const kept of ['.mcp.json', '.claude/settings.local.json', '.git/config']) {
    expect(readTextFile(root, kept).editable).toBe(false)
    expect(() => writeTextFile(root, kept, 'x')).toThrow('The office manages this file')
  }
  expect(() => readTextFile(root, 'logo.bin')).toThrow("isn't a text file")
  expect(() => readTextFile(root, '../outside.txt')).toThrow()
})

test('hidden files are listed only when asked', () => {
  expect(listFolder(root).entries.map((e) => e.name)).not.toContain('.env')
  expect(listFolder(root, '', true).entries.map((e) => e.name)).toEqual(expect.arrayContaining(['.env', '.claude', '.git', 'notes.md']))
  expect(listFolder(root, '.claude', true).entries.map((e) => e.name)).toContain('settings.local.json')
})

test('the git line of a folder: branch, what is not committed, which entries it touches', async () => {
  const { folderGit } = await import('./workspaces')
  const repo = join(PROJECTS_DIR, 'git-line-test')
  mkdirSync(join(repo, 'app'), { recursive: true })
  writeFileSync(join(repo, 'README.md'), '# r\n')
  writeFileSync(join(repo, 'app', 'main.js'), 'x\n')
  writeFileSync(join(repo, 'old.txt'), 'old\n')
  const g = (...a: string[]) => Bun.spawnSync(['git', '-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a])
  g('init', '-q', '-b', 'main')
  g('add', '.')
  g('commit', '-qm', 'first commit')
  expect(await folderGit(join(PROJECTS_DIR, 'editor-test'))).toBeNull()
  const clean = (await folderGit(repo))!
  expect(clean.branch).toBe('main')
  expect(clean.dirty).toBe(0)
  expect(clean.lastCommit?.subject).toBe('first commit')
  writeFileSync(join(repo, 'app', 'main.js'), 'y\n')
  writeFileSync(join(repo, 'new.md'), 'n\n')
  g('rm', '-q', 'old.txt')
  const dirty = (await folderGit(repo))!
  expect(dirty.dirty).toBe(3)
  expect(dirty.entries).toEqual({ app: 'M', 'new.md': 'U', 'old.txt': 'D' })
  // from inside a subfolder: the same repo, its own entries
  expect((await folderGit(repo, 'app'))!.entries).toEqual({ 'main.js': 'M' })
})
