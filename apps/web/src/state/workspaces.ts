import { create } from 'zustand'
import type { Workspace, WorkspaceFolder } from '@after-office/shared'
import { liveApi } from './live'
import { useOffice } from './store'

// The agents' folders (Projects tab, and the folders offered in the task form's project picker). Loaded on demand,
// shared by everything that shows them; the server caches its scan for 20 s.

interface WorkspaceStore {
  data: Workspace[] | null
  error: string | null
  loading: boolean
  /** goes up with each fresh read (the refresh button): open folders in the tree read their contents again */
  stamp: number
  load: (fresh?: boolean) => Promise<void>
}

export const useWorkspaces = create<WorkspaceStore>((set, get) => ({
  data: null,
  error: null,
  loading: false,
  stamp: 0,
  load: async (fresh = false) => {
    if (useOffice.getState().source !== 'live' || get().loading) return
    set({ loading: true })
    try {
      set({ data: await liveApi.workspaces(fresh), error: null, ...(fresh ? { stamp: get().stamp + 1 } : {}) })
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ loading: false })
    }
  },
}))

/** Every folder that is a project: agent folders that are one, and the projects inside the others. */
export function projectFolders(data: Workspace[] | null): WorkspaceFolder[] {
  if (!data) return []
  return data.flatMap((w) => (w.isProject ? [w] : w.projects))
}
