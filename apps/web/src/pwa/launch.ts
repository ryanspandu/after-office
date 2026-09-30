import { create } from 'zustand'

// App shortcuts (manifest "shortcuts", long-press on the app icon) open After Office at /?open=<panel>. The wish is
// read once at startup and the URL cleaned; the panel that can show it takes it (and clears it).

export type LaunchPanel = 'manager' | 'tasks' | 'attention'
const PANELS: LaunchPanel[] = ['manager', 'tasks', 'attention']

function initial(): LaunchPanel | null {
  const params = new URLSearchParams(window.location.search)
  const open = params.get('open') as LaunchPanel | null
  if (!open) return null
  params.delete('open')
  const qs = params.toString()
  window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`)
  return PANELS.includes(open) ? open : null
}

export const useLaunch = create<{ open: LaunchPanel | null; done: () => void }>((set) => ({
  open: initial(),
  done: () => set({ open: null }),
}))
