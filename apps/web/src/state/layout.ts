import { create } from 'zustand'

// The desktop's layout (ui/DeskLayout.tsx): columns side by side, each a stack of panels. Columns and panels resize by
// their gutters; in layout mode a panel can be dragged into another column (above or below a panel) or out to a column
// of its own. Kept in this browser. Phones and narrow windows keep their fixed layout.

export type PanelId = 'daily' | 'work' | 'office' | 'attention' | 'reports' | 'agents'
export const PANEL_IDS: PanelId[] = ['daily', 'work', 'office', 'attention', 'reports', 'agents']
export const PANEL_LABEL: Record<PanelId, string> = {
  daily: 'Daily',
  work: 'Tasks · Folders · Tags',
  office: 'Office',
  attention: 'For you',
  reports: 'Reports',
  agents: 'Agents',
}

export interface LayoutPanel {
  id: PanelId
  /** % of its column's height */
  size: number
}
export interface LayoutColumn {
  id: string
  /** % of the width */
  width: number
  panels: LayoutPanel[]
}

/** Where a dragged panel lands: above or below another panel, or in a new column left or right of a column. */
export type DropTarget = { panel: PanelId; side: 'above' | 'below' } | { column: string; side: 'left' | 'right' }

const STORAGE_KEY = 'after-office:layout'

export const DEFAULT_LAYOUT: LayoutColumn[] = [
  { id: 'c-left', width: 19, panels: [{ id: 'daily', size: 32 }, { id: 'work', size: 68 }] },
  { id: 'c-mid', width: 60, panels: [{ id: 'office', size: 78 }, { id: 'attention', size: 22 }] },
  { id: 'c-right', width: 21, panels: [{ id: 'reports', size: 42 }, { id: 'agents', size: 58 }] },
]

/** Sizes that add up to 100 (others scaled to make room). */
function normalize<T>(items: T[], get: (x: T) => number, set: (x: T, v: number) => T): T[] {
  const total = items.reduce((n, x) => n + Math.max(1, get(x)), 0)
  return items.map((x) => set(x, (Math.max(1, get(x)) / total) * 100))
}

/** A stored layout that still holds every panel exactly once (else the default: a panel added later, a broken save). */
function valid(cols: unknown): cols is LayoutColumn[] {
  if (!Array.isArray(cols) || !cols.length) return false
  const seen = cols.flatMap((c: LayoutColumn) => (Array.isArray(c?.panels) ? c.panels.map((p) => p?.id) : []))
  return seen.length === PANEL_IDS.length && PANEL_IDS.every((id) => seen.includes(id)) && cols.every((c: LayoutColumn) => typeof c.id === 'string' && typeof c.width === 'number' && c.panels.length > 0)
}

function load(): LayoutColumn[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as unknown
    return valid(saved) ? saved : DEFAULT_LAYOUT
  } catch {
    return DEFAULT_LAYOUT
  }
}

/** The layout with `panel` moved to `to` (pure, for tests). */
export function movePanel(cols: LayoutColumn[], panel: PanelId, to: DropTarget): LayoutColumn[] {
  const from = cols.find((c) => c.panels.some((p) => p.id === panel))
  if (!from) return cols
  // taken out of its column (its share goes to the others there)
  let next = cols.map((c) =>
    c.id === from.id
      ? { ...c, panels: normalize(c.panels.filter((p) => p.id !== panel), (p) => p.size, (p, size) => ({ ...p, size })) }
      : c,
  )
  if ('column' in to) {
    const at = next.findIndex((c) => c.id === to.column)
    if (at < 0) return cols
    const col: LayoutColumn = { id: `c-${Date.now().toString(36)}`, width: 100 / (cols.length + 1), panels: [{ id: panel, size: 100 }] }
    // the new column takes a fair part of the width; the others are scaled to make room
    next.splice(to.side === 'left' ? at : at + 1, 0, col)
  } else {
    if (to.panel === panel) return cols
    next = next.map((c) => {
      const i = c.panels.findIndex((p) => p.id === to.panel)
      if (i < 0) return c
      const panels = [...c.panels]
      // an even share for the newcomer, the others scaled to make room
      panels.splice(to.side === 'above' ? i : i + 1, 0, { id: panel, size: 100 / (panels.length + 1) })
      return { ...c, panels: normalize(panels, (p) => p.size, (p, size) => ({ ...p, size })) }
    })
  }
  next = next.filter((c) => c.panels.length > 0)
  return normalize(next, (c) => c.width, (c, width) => ({ ...c, width }))
}

interface LayoutStore {
  columns: LayoutColumn[]
  /** layout mode: panels show a handle to drag them around */
  editing: boolean
  setEditing: (on: boolean) => void
  setWidths: (widths: number[]) => void
  setSizes: (colId: string, sizes: number[]) => void
  move: (panel: PanelId, to: DropTarget) => void
  reset: () => void
}

export const useLayout = create<LayoutStore>((set, get) => {
  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(get().columns))
    } catch {
      // storage unavailable: this visit only
    }
  }
  return {
    columns: load(),
    editing: false,
    setEditing: (editing) => set({ editing }),
    setWidths: (widths) => {
      const cols = get().columns
      if (widths.length !== cols.length) return
      set({ columns: cols.map((c, i) => ({ ...c, width: widths[i] })) })
      save()
    },
    setSizes: (colId, sizes) => {
      set({
        columns: get().columns.map((c) => (c.id === colId && sizes.length === c.panels.length ? { ...c, panels: c.panels.map((p, i) => ({ ...p, size: sizes[i] })) } : c)),
      })
      save()
    },
    move: (panel, to) => {
      set({ columns: movePanel(get().columns, panel, to) })
      save()
    },
    reset: () => {
      set({ columns: DEFAULT_LAYOUT })
      save()
    },
  }
})
