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

test('the git bar: branches, switching, and pulling a straight catch-up', async () => {
  const { gitBranches, gitSwitch, gitPull, gitCommit, gitPush } = await import('./workspaces')
  const mine = join(PROJECTS_DIR, 'git-branch-test')
  const theirs = join(PROJECTS_DIR, 'git-branch-theirs')
  const remote = join(PROJECTS_DIR, 'git-branch-remote.git')
  mkdirSync(mine, { recursive: true })
  const g = (dir: string, ...a: string[]) => Bun.spawnSync(['git', '-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@t', ...a])
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'main', remote])
  g(mine, 'init', '-q', '-b', 'main')
  g(mine, 'config', 'user.name', 'T')
  g(mine, 'config', 'user.email', 't@t')
  writeFileSync(join(mine, 'a.txt'), '1\n')
  await gitCommit(mine, '', 'one')
  g(mine, 'remote', 'add', 'origin', remote)
  await gitPush(mine)
  // a second checkout adds a commit and a branch on the remote
  Bun.spawnSync(['git', 'clone', '-q', remote, theirs])
  writeFileSync(join(theirs, 'a.txt'), '2\n')
  g(theirs, 'commit', '-qam', 'two')
  g(theirs, 'push', '-q', 'origin', 'main')
  g(theirs, 'switch', '-q', '-c', 'feature/x')
  g(theirs, 'push', '-q', 'origin', 'feature/x')
  // pull brings main up to date
  expect((await gitPull(mine)).upToDate).toBe(false)
  expect(readFileSync(join(mine, 'a.txt'), 'utf8')).toBe('2\n')
  expect((await gitPull(mine)).upToDate).toBe(true)
  // the remote branch is listed (after a fetch) and can be switched to; so can the one we had
  g(mine, 'fetch', '-q')
  const b = await gitBranches(mine)
  expect(b.current).toBe('main')
  expect(b.local).toEqual(['main'])
  expect(b.remote).toEqual(['feature/x'])
  await gitSwitch(mine, '', 'feature/x')
  expect((await gitBranches(mine)).current).toBe('feature/x')
  await gitSwitch(mine, '', 'main')
  // bad names are refused, unknown ones are not found
  await expect(gitSwitch(mine, '', '--force')).rejects.toThrow('not a branch name')
  await expect(gitSwitch(mine, '', 'a..b')).rejects.toThrow('not a branch name')
  await expect(gitSwitch(mine, '', 'nope')).rejects.toThrow('no branch called')
  // changes that the switch would lose stop it
  g(mine, 'switch', '-q', '-c', 'other')
  writeFileSync(join(mine, 'a.txt'), 'other\n')
  g(mine, 'commit', '-qam', 'other change')
  g(mine, 'switch', '-q', 'main')
  writeFileSync(join(mine, 'a.txt'), 'dirty\n')
  await expect(gitSwitch(mine, '', 'other')).rejects.toThrow('commit or discard')
})
