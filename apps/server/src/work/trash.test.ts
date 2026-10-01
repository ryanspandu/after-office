import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENTS_DIR, PROJECTS_DIR } from '../fsroots'
import { renameEntry } from './workspaces'
import { emptyTrash, listTrash, purgeTrash, restoreTrash, TRASH_DIR, trashEntries } from './trash'

// The file manager: rename in place; delete = into the office's trash (never inside the project), restore, empty.

const root = join(PROJECTS_DIR, 'tr-site')
mkdirSync(join(root, 'docs'), { recursive: true })
writeFileSync(join(root, 'a.md'), 'A')
writeFileSync(join(root, 'docs', 'b.md'), 'B')
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  emptyTrash(root)
})

test('rename: in place, plain names only, never over something there, never outside', () => {
  expect(renameEntry(root, 'a.md', 'intro.md')).toEqual({ name: 'intro.md' })
  expect(readFileSync(join(root, 'intro.md'), 'utf8')).toBe('A')
  expect(() => renameEntry(root, 'intro.md', 'docs')).toThrow('already there')
  expect(() => renameEntry(root, 'intro.md', '../x.md')).toThrow('plain name')
  expect(() => renameEntry(root, 'intro.md', '.env')).toThrow('plain name')
  expect(() => renameEntry(root, '../tr-other', 'x')).toThrow('Invalid path')
  expect(() => renameEntry(root, 'missing.md', 'x.md')).toThrow('No such')
})

test('delete goes to the trash outside the project, and comes back where it was', () => {
  const [item] = trashEntries(root, ['docs'])
  expect(existsSync(join(root, 'docs'))).toBe(false)
  expect(TRASH_DIR.startsWith(AGENTS_DIR)).toBe(true)
  expect(root.startsWith(TRASH_DIR)).toBe(false)
  expect(item).toMatchObject({ name: 'docs', original: join(root, 'docs'), dir: true, size: 1 })
  expect(listTrash(root).map((i) => i.id)).toEqual([item.id])
  // something new took its place meanwhile: restored beside it
  mkdirSync(join(root, 'docs'))
  expect(restoreTrash(item.id).path).toBe(join(root, 'docs (restored)'))
  expect(readFileSync(join(root, 'docs (restored)', 'b.md'), 'utf8')).toBe('B')
  expect(listTrash(root)).toEqual([])
})

test('a link is trashed as itself (what it points to stays); deleting for good and emptying', () => {
  const outside = join(AGENTS_DIR, 'tr-outside.txt')
  writeFileSync(outside, 'keep me')
  symlinkSync(outside, join(root, 'link.txt'))
  const [link] = trashEntries(root, ['link.txt'])
  expect(readFileSync(outside, 'utf8')).toBe('keep me')
  purgeTrash(link.id)
  expect(readFileSync(outside, 'utf8')).toBe('keep me')
  rmSync(outside)
  trashEntries(root, ['intro.md'])
  expect(emptyTrash(root)).toEqual({ removed: 1 })
  expect(listTrash(root)).toEqual([])
  expect(() => trashEntries(root, ['../tr-site'])).toThrow('Invalid path')
  expect(() => restoreTrash('nope-nope')).toThrow('Not in the trash')
})

test("a folder's notes live in the database and follow the folder when it's renamed", async () => {
  const { folderNotesRepo } = await import('../db')
  mkdirSync(join(root, 'drafts', 'inner'), { recursive: true })
  folderNotesRepo.set(join(root, 'drafts'), '- check the intro')
  folderNotesRepo.set(join(root, 'drafts', 'inner'), 'inner notes')
  expect(existsSync(join(root, 'drafts', 'NOTES.md'))).toBe(false)
  renameEntry(root, 'drafts', 'drafts-v2')
  expect(folderNotesRepo.get(join(root, 'drafts'))).toBeNull()
  expect(folderNotesRepo.get(join(root, 'drafts-v2'))?.text).toBe('- check the intro')
  expect(folderNotesRepo.get(join(root, 'drafts-v2', 'inner'))?.text).toBe('inner notes')
  folderNotesRepo.set(join(root, 'drafts-v2'), '   ')
  expect(folderNotesRepo.get(join(root, 'drafts-v2'))).toBeNull()
  folderNotesRepo.set(join(root, 'drafts-v2', 'inner'), '')
})
