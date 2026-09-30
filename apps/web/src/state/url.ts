import { create } from 'zustand'

// Modals and panels live in the address bar, so any of them can be opened from a link (and bookmarked, shared with
// yourself, or reopened after a reload). The URL is the source of truth: buttons set a parameter, ui/UrlModals.tsx
// shows what the parameters ask for, and Back closes what was opened last.
//
//   ?task=<id>  ?report=<id>  ?reports=<filter>&project=&q=&range=&from=&to=&page=&per=  ?tasks=1  ?archive=1  ?projects=1
//   ?folder=<path>  ?newproject=1  ?newtask=1&nt_agent=&nt_project=&nt_status=  ?daily=<id>|new  ?addagent=1|manager
//   ?agent=<id>&tab=<tab>  ?manager=1&mtab=chat|team  ?automation=1  ?profile=1  ?settings=1 (project settings)  ?password=1  ?twofa=1  ?activity=1
//   reports view also: &tag=<id,id>

type Params = Record<string, string>

const read = (): Params => (typeof window === 'undefined' ? {} : Object.fromEntries(new URLSearchParams(window.location.search)))
export const useUrl = create<{ params: Params }>(() => ({ params: read() }))

if (typeof window !== 'undefined') window.addEventListener('popstate', () => useUrl.setState({ params: read() }))

/**
 * Change parameters (null / '' removes one). Opening something adds a history entry, so Back closes it; closing it
 * or changing a filter replaces the entry instead.
 */
export function setUrl(patch: Record<string, string | number | null | undefined>, mode: 'push' | 'replace' = 'replace') {
  const params = new URLSearchParams(window.location.search)
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '') params.delete(k)
    else params.set(k, String(v))
  }
  const qs = params.toString()
  const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
  if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return
  window.history[mode === 'push' ? 'pushState' : 'replaceState'](window.history.state, '', next)
  useUrl.setState({ params: read() })
}

/** Open something: set its parameters as a new history entry. */
export const openUrl = (patch: Record<string, string | number | null | undefined>) => setUrl(patch, 'push')

export const useParam = (key: string) => useUrl((s) => s.params[key] ?? null)
export const getParam = (key: string) => useUrl.getState().params[key] ?? null
