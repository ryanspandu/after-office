import { create } from 'zustand'
import type { ActivityEntry } from '@after-office/shared'

// The Activity log as it happens: entries the server streams (new ones, and updates of running ones). Lists fetch
// their page from /api/activity and lay these over it.

export const useActivityLive = create<{ byId: Record<string, ActivityEntry>; push: (e: ActivityEntry) => void }>((set) => ({
  byId: {},
  push: (e) =>
    set((s) => {
      const byId = { ...s.byId, [e.id]: e }
      const ids = Object.keys(byId)
      // only the latest few hundred are kept here
      if (ids.length > 400) for (const id of ids.sort((a, b) => byId[a].at - byId[b].at).slice(0, ids.length - 400)) delete byId[id]
      return { byId }
    }),
}))
