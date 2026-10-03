import { create } from 'zustand'

// Folder and note windows put aside (minimized): a chip each at the bottom right, one click opens it again as it was left. The
// window stays mounted while minimized (hidden), so its files view, a terminal or unsaved notes are kept. The list
// (and the section each was on) is remembered in this browser, so after a reload the chips are still there.

const STORAGE_KEY = 'after-office:minimized-folders'
/** the Tasks window's place in the list (one at most) */
export const TASKS = '@tasks'
/** …and the Reports window's */
export const REPORTS = '@reports'

export interface MinimizedFolder {
  /** a folder's path, or a note's id (kind 'note') */
  path: string
  /** unset: a folder window; 'note': one of the owner's notes (Reports → Notes); 'tasks' / 'reports': those windows */
  kind?: 'note' | 'tasks' | 'reports' | 'report'
  /** the Tasks / Reports window: its view as it was left (the address bar's parameters: search, sort, page…) */
  params?: Record<string, string>
  /** a note's title when it was put aside (the list's own title wins when there is one) */
  label?: string
  /** the sidebar section it was on (Files, Notes, Terminal…) */
  section?: string
}

function load(): MinimizedFolder[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((f): f is MinimizedFolder => typeof f?.path === 'string') : []
  } catch {
    return []
  }
}

interface MinimizedStore {
  folders: MinimizedFolder[]
  add: (path: string, section?: string) => void
  /** a note's window put aside */
  addNote: (id: string, label: string) => void
  /** one report's window put aside (its id, its title) */
  addReport: (id: string, label: string) => void
  /** the Tasks or Reports window put aside, with its view */
  addView: (kind: 'tasks' | 'reports', params: Record<string, string>) => void
  remove: (path: string) => void
  /** what a folder's window is showing, kept for when it opens again */
  setSection: (path: string, section: string) => void
}

export const useMinimized = create<MinimizedStore>((set, get) => {
  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(get().folders))
    } catch {
      // storage unavailable: the chips last until the page reloads
    }
  }
  return {
    folders: load(),
    add: (path, section) => {
      const known = get().folders.find((f) => f.path === path)
      set({ folders: known ? get().folders.map((f) => (f.path === path ? { ...f, section: section ?? f.section } : f)) : [...get().folders, { path, section }] })
      save()
    },
    addNote: (id, label) => {
      const known = get().folders.some((f) => f.path === id)
      set({ folders: known ? get().folders.map((f) => (f.path === id ? { ...f, label } : f)) : [...get().folders, { path: id, kind: 'note', label }] })
      save()
    },
    addReport: (id, label) => {
      const rest = get().folders.filter((f) => f.path !== `report:${id}`)
      set({ folders: [...rest, { path: `report:${id}`, kind: 'report', label }] })
      save()
    },
    addView: (kind, params) => {
      const path = kind === 'tasks' ? TASKS : REPORTS
      const rest = get().folders.filter((f) => f.path !== path)
      set({ folders: [...rest, { path, kind, label: kind === 'tasks' ? 'Tasks' : 'Reports', params }] })
      save()
    },
    remove: (path) => {
      set({ folders: get().folders.filter((f) => f.path !== path) })
      save()
    },
    setSection: (path, section) => {
      if (!get().folders.some((f) => f.path === path && f.section !== section)) return
      set({ folders: get().folders.map((f) => (f.path === path ? { ...f, section } : f)) })
      save()
    },
  }
})
