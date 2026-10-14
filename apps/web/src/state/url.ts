import { create } from 'zustand'

// Modals and panels live in the address bar, so any of them can be opened from a link (and bookmarked, shared with
// yourself, or reopened after a reload). The URL is the source of truth: buttons set a parameter, ui/UrlModals.tsx
// shows what the parameters ask for, and Back closes what was opened last.
//
//   ?task=<id>  ?report=<id>  ?reports=<filter>&folder=&q=&range=&from=&to=&page=&per=&ri=<id> (the one read in the inbox)  ?tasks=1&tq=&tsort=title|deadline|status|priority|agent&tdir=asc|desc&tpage=&tper=  ?archive=1  ?statuses=1 (the task statuses' editor)
//   ?folder=<path>  ?newfolder=1  ?newtask=1&nt_agent=&nt_folder=&nt_status=&nt_tag=  ?note=<id>|new&nfolder=&ntag=  ?notes=1&nq=&nview=  ?daily=<id>|new  ?addagent=1|manager
//   ?agent=<id>&tab=<tab>  ?manager=1&mtab=chat|team  ?automation=1  ?profile=1  ?settings=1 (office branding)  ?tools=1 (proxy, API keys)  ?password=1  ?twofa=1  ?activity=1
//   reports view also: &tag=<id,id>
//   ?thread=<id>|new (ui/ThreadView.tsx, ui/Threads.tsx)  ?newtask=1&nt_thread=<id> (a task made in a thread)
//   phones: ?nwrite=1 (writing a note on the whole screen: Back ends it, ui/FolderNotes.tsx)
//   phones: ?sheet=attention|cron|tasks|reports|agents|threads (the dock's bottom sheets, ui/MobileDock.tsx; threads: the stage's button)

type Params = Record<string, string>

const read = (): Params => (typeof window === 'undefined' ? {} : Object.fromEntries(new URLSearchParams(window.location.search)))
export const useUrl = create<{ params: Params }>(() => ({ params: read() }))

// changes asked for while our own Back is still on its way: made once it has landed (in order)
let backing: Array<() => void> | null = null
if (typeof window !== 'undefined')
  window.addEventListener('popstate', () => {
    // left a window's own step (Back on a maximized one): it undoes it
    if (step && (window.history.state as { aoStep?: string } | null)?.aoStep !== step.id) {
      const left = step
      step = null
      // what changed on top of it (a filter) stays changed
      if (left.url && left.url !== here()) window.history.replaceState(window.history.state, '', left.url)
      left.onBack()
    }
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
  // a window's step on top (a maximized window, phones): closing the window goes out of the step first; other changes
  // are made in place
  const top = window.history.state as { aoStep?: string; below?: { aoFrom?: string } | null } | null
  if (mode === 'replace' && top?.aoStep && step?.id === top.aoStep) {
    const next = withPatch(patch)
    // closing what the page under it opened: out of the step, then closed (two Backs)
    if (top.below?.aoFrom === next) {
      step.url = undefined
      return void goBack(() => setUrl(patch, mode))
    }
    // anything else (a filter): changed in place, and kept when the step goes
    window.history.replaceState(top, '', next)
    step.url = next
    useUrl.setState({ params: read() })
    return
  }
  const now = here()
  const next = withPatch(patch)
  if (next === now) return
  // Closing what this history entry opened (back to exactly the page it was opened from): go Back instead of
  // rewriting the entry. Otherwise the entry stays behind as a copy of the page below, and the phone's Back gesture
  // later lands on that copy and seems to do nothing (the window under it doesn't close).
  const state = window.history.state as { aoFrom?: string } | null
  if (mode === 'replace' && state?.aoFrom === next) return void goBack()
  if (mode === 'push') window.history.pushState({ aoFrom: now }, '', next)
  else window.history.replaceState(window.history.state, '', next)
  useUrl.setState({ params: read() })
}

const here = () => `${window.location.pathname}${window.location.search}${window.location.hash}`
/** The address with these parameters changed (null / '' removes one). */
function withPatch(patch: Record<string, string | number | null | undefined>) {
  const params = new URLSearchParams(window.location.search)
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '') params.delete(k)
    else params.set(k, String(v))
  }
  const qs = params.toString()
  return `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
}

/** Back one entry; what's asked for meanwhile (and `then`) is done once it has landed. */
function goBack(then?: () => void) {
  const mine: Array<() => void> = then ? [then] : []
  backing = mine
  window.history.back()
  // never stuck if the Back doesn't come (it always should: the entry left was pushed by us)
  setTimeout(() => {
    if (backing !== mine) return
    backing = null
    mine.forEach((fn) => fn())
  }, 600)
}

// ── a window's own step (phones: a maximized window): Back undoes it before it closes anything ──
let step: { id: string; onBack: () => void; url?: string } | null = null

/** A step of a window's own on top of the page (same address): the Back gesture calls `onBack` instead of leaving. */
export function pushStep(onBack: () => void) {
  const id = Math.random().toString(36).slice(2)
  // the entry under it: how its window closes (state.aoFrom), for setUrl
  window.history.pushState({ aoStep: id, below: window.history.state }, '', window.location.href)
  step = { id, onBack }
  return id
}

/** Undo a step from the window itself (its button): Back, which calls its `onBack`. */
export function dropStep(id: string) {
  if (step?.id !== id) return
  if ((window.history.state as { aoStep?: string } | null)?.aoStep === id) goBack()
  else step = null
}

/** The window is gone: its step goes too, quietly (no `onBack`). */
export function forgetStep(id: string) {
  if (step?.id !== id) return
  step.onBack = () => {}
  dropStep(id)
}

/** Open something: set its parameters as a new history entry. */
export const openUrl = (patch: Record<string, string | number | null | undefined>) => setUrl(patch, 'push')

export const useParam = (key: string) => useUrl((s) => s.params[key] ?? null)
export const getParam = (key: string) => useUrl.getState().params[key] ?? null
