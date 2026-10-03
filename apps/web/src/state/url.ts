import { create } from 'zustand'

// Modals and panels live in the address bar, so any of them can be opened from a link (and bookmarked, shared with
// yourself, or reopened after a reload). The URL is the source of truth: buttons set a parameter, ui/UrlModals.tsx
// shows what the parameters ask for, and Back closes what was opened last.
//
//   ?task=<id>  ?report=<id>  ?reports=<filter>&folder=&q=&range=&from=&to=&page=&per=&ri=<id> (the one read in the inbox)  ?tasks=1&tq=&tsort=title|deadline|status|priority|agent&tdir=asc|desc&tpage=&tper=  ?archive=1  ?statuses=1 (the task statuses' editor)
//   ?folder=<path>  ?newfolder=1  ?newtask=1&nt_agent=&nt_folder=&nt_status=  ?note=<id>|new&nfolder=  ?notes=1  ?daily=<id>|new  ?addagent=1|manager
//   ?agent=<id>&tab=<tab>  ?manager=1&mtab=chat|team  ?automation=1  ?profile=1  ?settings=1 (office branding)  ?password=1  ?twofa=1  ?activity=1
//   reports view also: &tag=<id,id>
//   phones: ?sheet=attention|cron|tasks|reports|agents (the dock's bottom sheets, ui/MobileDock.tsx)

type Params = Record<string, string>

const read = (): Params => (typeof window === 'undefined' ? {} : Object.fromEntries(new URLSearchParams(window.location.search)))
export const useUrl = create<{ params: Params }>(() => ({ params: read() }))

// changes asked for while our own Back is still on its way: made once it has landed (in order)
let backing: Array<() => void> | null = null
if (typeof window !== 'undefined')
  window.addEventListener('popstate', () => {
    useUrl.setState({ params: read() })
    const queued = backing
    backing = null
    queued?.forEach((fn) => fn())
  })

/**
 * Change parameters (null / '' removes one). Opening something adds a history entry, so Back closes it; closing it
 * or changing a filter replaces the entry instead.
 */
export function setUrl(patch: Record<string, string | number | null | undefined>, mode: 'push' | 'replace' = 'replace') {
  if (backing) return void backing.push(() => setUrl(patch, mode))
  const params = new URLSearchParams(window.location.search)
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '') params.delete(k)
    else params.set(k, String(v))
  }
  const qs = params.toString()
  const here = `${window.location.pathname}${window.location.search}${window.location.hash}`
  const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
  if (next === here) return
  // Closing what this history entry opened (back to exactly the page it was opened from): go Back instead of
  // rewriting the entry. Otherwise the entry stays behind as a copy of the page below, and the phone's Back gesture
  // later lands on that copy and seems to do nothing (the window under it doesn't close).
  const state = window.history.state as { aoFrom?: string } | null
  if (mode === 'replace' && state?.aoFrom === next) {
    const mine: Array<() => void> = []
    backing = mine
    window.history.back()
    // never stuck if the Back doesn't come (it always should: this entry was pushed on top of `aoFrom`)
    setTimeout(() => {
      if (backing !== mine) return
      backing = null
      mine.forEach((fn) => fn())
    }, 600)
    return
  }
  if (mode === 'push') window.history.pushState({ aoFrom: here }, '', next)
  else window.history.replaceState(window.history.state, '', next)
  useUrl.setState({ params: read() })
}

/** Open something: set its parameters as a new history entry. */
export const openUrl = (patch: Record<string, string | number | null | undefined>) => setUrl(patch, 'push')

export const useParam = (key: string) => useUrl((s) => s.params[key] ?? null)
export const getParam = (key: string) => useUrl.getState().params[key] ?? null
