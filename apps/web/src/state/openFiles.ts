import { create } from 'zustand'
import { useMinimized } from './minimized'

// Text files open in the editor (ui/FileEditor.tsx), as windows of the app rather than of the folder they came from:
// one can be minimized to a chip and stay open (with what's typed in it) while its folder window is closed. A chip
// left from before a reload opens its file again.

export interface OpenFile {
  /** `file:<root>::<path>`, also its chip's id */
  key: string
  root: string
  path: string
  /** opened to change it (a new file, Edit from its menu) rather than to read it */
  edit: boolean
}

export const fileKey = (root: string, path: string) => `file:${root}::${path}`
export const parseFileKey = (key: string) => {
  const rest = key.slice('file:'.length)
  const at = rest.indexOf('::')
  return at < 0 ? null : { root: rest.slice(0, at), path: rest.slice(at + 2) }
}

interface State {
  files: OpenFile[]
  /** the last save: a folder showing that root reloads its list */
  saved: { root: string; at: number } | null
}

export const useOpenFiles = create<State>(() => ({ files: [], saved: null }))

/** Open (or bring back) a file's window. */
export function openFile(root: string, path: string, edit = false) {
  const key = fileKey(root, path)
  useMinimized.getState().remove(key)
  useOpenFiles.setState((s) => (s.files.some((f) => f.key === key) ? s : { files: [...s.files, { key, root, path, edit }] }))
}

/** Put it aside: a chip, the window kept (hidden) with what's typed in it. */
export function minimizeFile(key: string, label: string) {
  useMinimized.getState().addFile(key, label)
}

/** Closed for good. */
export function closeFile(key: string) {
  useMinimized.getState().remove(key)
  useOpenFiles.setState((s) => ({ files: s.files.filter((f) => f.key !== key) }))
}

export const fileSaved = (root: string) => useOpenFiles.setState({ saved: { root, at: Date.now() } })
