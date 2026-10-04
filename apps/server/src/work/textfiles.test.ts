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

test('a new, empty file: any name and extension, dotfiles too; never over one, never in .git', async () => {
  const { addEmptyFile } = await import('./workspaces')
  expect(addEmptyFile(root, '', 'script.rb').path).toBe('script.rb')
  expect(readTextFile(root, 'script.rb').text).toBe('')
  expect(addEmptyFile(root, '', '.prettierrc').name).toBe('.prettierrc')
  expect(addEmptyFile(root, '.claude', 'notes.txt').path).toBe('.claude/notes.txt')
  expect(() => addEmptyFile(root, '', 'script.rb')).toThrow('already there')
  expect(() => addEmptyFile(root, '', 'a/b.txt')).toThrow('plain name')
  expect(() => addEmptyFile(root, '.git', 'hooks.txt')).toThrow('The office manages')
  expect(() => addEmptyFile(root, '', '.mcp.json')).toThrow()
})

test('the git bar: commit everything, push (setting the upstream), discard what is not committed', async () => {
  const { folderGit, gitCommit, gitDiscard, gitPush } = await import('./workspaces')
  const repo = join(PROJECTS_DIR, 'git-actions-test')
  const remote = join(PROJECTS_DIR, 'git-actions-remote.git')
  mkdirSync(repo, { recursive: true })
  const g = (...a: string[]) => Bun.spawnSync(['git', '-C', repo, ...a])
  Bun.spawnSync(['git', 'init', '-q', '--bare', remote])
  g('init', '-q', '-b', 'main')
  g('config', 'user.name', 'Tester')
  g('config', 'user.email', 't@t')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  await expect(gitCommit(repo, '', '  ')).rejects.toThrow('commit message')
  const done = await gitCommit(repo, '', 'first from the dashboard')
  expect(done.subject).toBe('first from the dashboard')
  expect((await folderGit(repo))!.dirty).toBe(0)
  await expect(gitCommit(repo, '', 'again')).rejects.toThrow('Nothing to commit')
  // no remote yet, then one: pushed with its upstream set
  await expect(gitPush(repo)).rejects.toThrow('no remote')
  g('remote', 'add', 'origin', remote)
  expect((await gitPush(repo)).ok).toBe(true)
  const after = (await folderGit(repo))!
  expect(after.hasRemote).toBe(true)
  expect(after.ahead).toBe(0)
  // changes and a new file, then discarded: back as committed; the office's own .mcp.json stays
  writeFileSync(join(repo, 'a.txt'), 'two\n')
  writeFileSync(join(repo, 'new.txt'), 'n\n')
  writeFileSync(join(repo, '.mcp.json'), '{}\n')
  await gitDiscard(repo)
  expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\n')
  expect(() => readFileSync(join(repo, 'new.txt'))).toThrow()
  expect(readFileSync(join(repo, '.mcp.json'), 'utf8')).toBe('{}\n')
})
