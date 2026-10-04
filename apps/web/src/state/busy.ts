import { create } from 'zustand'

// (Not the Activity log: that's state/activity.ts.) What the dashboard is busy saving or deleting right now, so it shows (ui/BusyPill.tsx) instead of happening
// silently: every write through api() (state/auth.ts) counts on its own (a delete, a save), and an action on many at
// once (Reports → Delete 10) reports its progress here too.

export type ActivityKind = 'delete' | 'save'

export interface Activity {
  id: number
  kind: ActivityKind
  /** what it's about, e.g. "report", "3 reports", "task" */
  label: string
  done?: number
  total?: number
  startedAt: number
}

interface ActivityState {
  items: Activity[]
  /** the last one that finished, for a short "Deleted" / "Saved" */
  finished: { kind: ActivityKind; label: string; at: number } | null
}

export const useBusy = create<ActivityState>(() => ({ items: [], finished: null }))

let seq = 0

/** Start one; returns how to report its progress and its end. */
export function beginBusy(kind: ActivityKind, label: string, total?: number) {
  const id = ++seq
  useBusy.setState((s) => ({ items: [...s.items, { id, kind, label, total, done: total ? 0 : undefined, startedAt: Date.now() }] }))
  return {
    progress: (done: number) => useBusy.setState((s) => ({ items: s.items.map((x) => (x.id === id ? { ...x, done } : x)) })),
    /** a failure isn't shown here: the caller says what went wrong (a save's error toast, the form's message) */
    end: (error?: string) =>
      useBusy.setState((s) => ({
        items: s.items.filter((x) => x.id !== id),
        finished: error ? s.finished : { kind, label, at: Date.now() },
      })),
  }
}

// what a write is about, from its address (only the ones worth naming; the rest is just "Saving…")
const NOUNS: [RegExp, string][] = [
  [/^\/api\/reports/, 'report'],
  [/^\/api\/tasks\/[^/]+\/comments/, 'note'],
  [/^\/api\/tasks/, 'task'],
  [/^\/api\/crons/, 'daily job'],
  [/^\/api\/tags/, 'tag'],
  [/^\/api\/notes/, 'note'],
  [/^\/api\/statuses/, 'status'],
  [/^\/api\/projects/, 'project'],
  [/^\/api\/workspaces/, 'file'],
  [/^\/api\/agents\/[^/]+\/secrets/, 'secret'],
  [/^\/api\/agents\/[^/]+\/git/, 'git settings'],
  [/^\/api\/agents/, 'agent'],
]
const nounOf = (path: string) => NOUNS.find(([re]) => re.test(path))?.[1] ?? ''

/**
 * The activity a request counts as, if any: deletes always; saves (PUT) too. Other POSTs (sending a message,
 * starting a task, signing in) are actions with their own feedback and don't count.
 */
export function busyFor(path: string, method: string): { kind: ActivityKind; label: string } | null {
  if (!path.startsWith('/api/') || path.startsWith('/api/auth')) return null
  if (method === 'DELETE') return { kind: 'delete', label: nounOf(path) }
  if (method === 'PUT') return { kind: 'save', label: nounOf(path) }
  return null
}
