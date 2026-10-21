import { memo, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Node, NodeViewWrapper, ReactNodeViewRenderer, mergeAttributes, type Editor, type ReactNodeViewProps } from '@tiptap/react'
import { getStroke } from 'perfect-freehand'
import { LuAlignCenter, LuAlignLeft, LuBrush, LuCheck, LuEraser, LuExpand, LuHighlighter, LuPencil, LuPenTool, LuRedo2, LuTrash2, LuUndo2, LuX } from 'react-icons/lu'
import { useBackStep } from '../state/useBackStep'
import { confirm } from './Confirm'
import { tip } from './Tooltip'

// A hand-drawn sketch in a note (ui/FolderNotes.tsx): <div data-type="drawing" data-width="800" data-height="320"
// data-strokes='[…]'>. Only its strokes are kept, as plain numbers and names from the lists below (never SVG): the
// picture is drawn here, from them, with perfect-freehand (pen pressure when there is one). Its width is the text's
// width when it was made (the strokes' own units, a viewBox), so it scales to any width; its height is dragged at
// its bottom edge. Agents read it as "[drawing: N strokes]" (packages/shared/src/noteText.ts).

/** pen, pencil (thinner, a little see-through), highlighter (wide, translucent) */
type Tool = 'pen' | 'pencil' | 'marker'
/** A stroke: its tool, colour, size (1–3), its points (x, y; with `pressure`, x, y, pressure), pressure (1: it has one). */
export type Stroke = [tool: Tool, colour: string, size: number, points: number[], pressure?: 1]

const TOOLS: Tool[] = ['pen', 'pencil', 'marker']
/** The colours (kept by name): ink follows the theme (light on dark, dark on light). */
const COLOURS: Record<string, string> = {
  ink: 'var(--draw-ink)',
  orange: '#e8762c',
  yellow: '#f4b817',
  green: '#2fbf71',
  blue: '#3b82f6',
  purple: '#8b5cf6',
  red: '#ef4444',
}
const COLOUR_NAMES = Object.keys(COLOURS)
/** Each tool's widths (in the drawing's units) for sizes 1, 2 and 3. */
const WIDTHS: Record<Tool, number[]> = { pen: [2.5, 5, 9], pencil: [1.5, 2.8, 5], marker: [10, 18, 30] }
const OPACITY: Record<Tool, number> = { pen: 1, pencil: 0.78, marker: 0.35 }

const DEFAULT_HEIGHT = 320
/** The most a drawing's strokes may take in the note's HTML (the whole note is 200k at most, work/notes.ts). */
const DRAW_MAX = 60_000
const clampInt = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d
}

/** Strokes read from HTML: only the known tools, colours and sizes, and plain numbers; anything else is dropped. */
export function cleanStrokes(raw: unknown): Stroke[] {
  if (!Array.isArray(raw)) return []
  const out: Stroke[] = []
  for (const s of raw.slice(0, 5000)) {
    if (!Array.isArray(s)) continue
    const [tool, colour, size, pts, pressure] = s as unknown[]
    if (!TOOLS.includes(tool as Tool) || typeof colour !== 'string' || !COLOUR_NAMES.includes(colour) || !Array.isArray(pts)) continue
    const step = pressure === 1 ? 3 : 2
    if (!pts.length || pts.length % step || !pts.every((n) => typeof n === 'number' && Number.isFinite(n))) continue
    out.push([tool as Tool, colour, clampInt(size, 1, 3, 2), pts as number[], ...(pressure === 1 ? [1 as const] : [])] as Stroke)
  }
  return out
}
const parseStrokes = (v: string | null) => {
  try {
    return cleanStrokes(JSON.parse(v ?? '[]'))
  } catch {
    return []
  }
}

/** The points of a stroke as [x, y, pressure?][] */
const pointsOf = (s: Stroke) => {
  const step = s[4] ? 3 : 2
  const out: number[][] = []
  for (let i = 0; i < s[3].length; i += step) out.push(step === 3 ? [s[3][i], s[3][i + 1], s[3][i + 2]] : [s[3][i], s[3][i + 1]])
  return out
}

const avg = (a: number, b: number) => ((a + b) / 2).toFixed(1)
/** perfect-freehand's outline as a filled SVG path (a dot when it's too short for curves). */
function outlinePath(outline: number[][]) {
  const n = outline.length
  if (!n) return ''
  if (n < 4) {
    const [x, y] = outline[0]
    return `M${x.toFixed(1)},${y.toFixed(1)}m-1,0a1,1 0 1,0 2,0a1,1 0 1,0 -2,0Z`
  }
  let d = `M${outline[0][0].toFixed(1)},${outline[0][1].toFixed(1)} Q${outline[1][0].toFixed(1)},${outline[1][1].toFixed(1)} ${avg(outline[1][0], outline[2][0])},${avg(outline[1][1], outline[2][1])} T`
  for (let i = 2; i < n - 1; i++) d += `${avg(outline[i][0], outline[i + 1][0])},${avg(outline[i][1], outline[i + 1][1])} `
  return `${d}Z`
}

/** A stroke's SVG path (`done`: let go, its end tapers as it should). */
function strokePath(s: Stroke, done = true) {
  const [tool, , size] = s
  const pressure = !!s[4]
  const width = WIDTHS[tool][size - 1] ?? WIDTHS[tool][1]
  const outline = getStroke(pointsOf(s), {
    size: width,
    thinning: tool === 'marker' ? 0 : tool === 'pencil' ? 0.35 : 0.6,
    smoothing: 0.5,
    streamline: tool === 'pencil' ? 0.35 : 0.5,
    simulatePressure: !pressure && tool !== 'marker',
    start: { cap: true },
    end: { cap: true },
    last: done,
  })
  return outlinePath(outline)
}

/** Fewer points along the same line (Ramer–Douglas–Peucker), rounded: 1 decimal, pressure 2. */
function simplify(s: Stroke, eps: number): Stroke {
  const pts = pointsOf(s)
  if (pts.length > 2) {
    const keep = new Uint8Array(pts.length)
    keep[0] = keep[pts.length - 1] = 1
    const stack: [number, number][] = [[0, pts.length - 1]]
    while (stack.length) {
      const [a, b] = stack.pop()!
      const [ax, ay] = pts[a]
      const [bx, by] = pts[b]
      const dx = bx - ax
      const dy = by - ay
      const len = Math.hypot(dx, dy) || 1
      let far = -1
      let max = eps
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len
        if (d > max) (max = d), (far = i)
      }
      if (far > 0) {
        keep[far] = 1
        stack.push([a, far], [far, b])
      }
    }
    pts.splice(0, pts.length, ...pts.filter((_, i) => keep[i]))
  }
  const flat = pts.flatMap((p) => (s[4] ? [r1(p[0]), r1(p[1]), Math.round((p[2] ?? 0.5) * 100) / 100] : [r1(p[0]), r1(p[1])]))
  return [s[0], s[1], s[2], flat, ...(s[4] ? [1 as const] : [])] as Stroke
}
const r1 = (n: number) => Math.round(n * 10) / 10
const sizeOf = (strokes: Stroke[]) => JSON.stringify(strokes).length

/** Whether a stroke passes within `r` of (x, y). */
function touches(s: Stroke, x: number, y: number, r: number) {
  const pts = pointsOf(s)
  const reach = r + (WIDTHS[s[0]][s[2] - 1] ?? 4) / 2
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i]
    const [bx, by] = pts[i + 1] ?? pts[i]
    const dx = bx - ax
    const dy = by - ay
    const t = dx || dy ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))) : 0
    if (Math.hypot(ax + t * dx - x, ay + t * dy - y) <= reach) return true
  }
  return false
}

// ── the node ──

/** A box width the note keeps: 5–100 (%), 100 meaning none (all of the text's width). */
const widthPct = (v: unknown) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n >= 5 && n < 100 ? n : null
}

/** A new drawing opens to draw right away (the one put in last, within a moment). */
let openNext = 0

/** Puts a new drawing in where the caret is, as wide as the text. */
export function insertDrawing(editor: Editor) {
  const el = editor.view.dom as HTMLElement
  const css = getComputedStyle(el)
  const width = clampInt(el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight), 200, 2000, 800)
  openNext = Date.now()
  return editor.chain().focus().insertContent({ type: 'drawing', attrs: { width, height: DEFAULT_HEIGHT, strokes: [] } }).run()
}

export const NoteDrawing = Node.create({
  name: 'drawing',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      width: {
        default: 800,
        parseHTML: (el: HTMLElement) => clampInt(el.getAttribute('data-width'), 100, 4000, 800),
        renderHTML: (a: { width: number }) => ({ 'data-width': String(a.width) }),
      },
      height: {
        default: DEFAULT_HEIGHT,
        parseHTML: (el: HTMLElement) => clampInt(el.getAttribute('data-height'), 40, 8000, DEFAULT_HEIGHT),
        renderHTML: (a: { height: number }) => ({ 'data-height': String(a.height) }),
      },
      // the box's width: a % of the text's width (none: all of it), and left or centred
      widthPct: {
        default: null,
        parseHTML: (el: HTMLElement) => widthPct(el.getAttribute('data-width-pct')),
        renderHTML: (a: { widthPct?: number | null }) => (a.widthPct ? { 'data-width-pct': String(a.widthPct) } : {}),
      },
      align: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.getAttribute('data-align') === 'center' ? 'center' : null),
        renderHTML: (a: { align?: string | null }) => (a.align ? { 'data-align': a.align } : {}),
      },
      strokes: {
        default: [],
        parseHTML: (el: HTMLElement) => parseStrokes(el.getAttribute('data-strokes')),
        renderHTML: (a: { strokes: Stroke[] }) => ({ 'data-strokes': JSON.stringify(a.strokes ?? []) }),
      },
    }
  },
  parseHTML: () => [{ tag: 'div[data-type="drawing"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes({ 'data-type': 'drawing' }, HTMLAttributes)],
  addNodeView() {
    return ReactNodeViewRenderer(DrawingView, {
      // the pad, its tools and its handle answer their own pointer (drags and drops still go to the editor)
      stopEvent: ({ event }) => {
        if (event.type.startsWith('drag') || event.type === 'drop') return false
        return !!(event.target as Element | null)?.closest?.('.drawing__pad, .drawing__tools, .drawing__resize, .drawing__draw')
      },
    })
  },
})

// ── the drawing in the note ──

/** Whether the note is being written (a node view isn't drawn again when the editor turns editable or back). */
function useEditable(editor: Editor) {
  const [on, set] = useState(editor.isEditable)
  useEffect(() => {
    const check = () => set(editor.isEditable)
    check()
    editor.on('update', check)
    editor.on('transaction', check)
    return () => void (editor.off('update', check), editor.off('transaction', check))
  }, [editor])
  return on
}

/** The last tool, colour and size used (the next drawing starts with them). */
const last = { tool: 'pen' as Tool | 'eraser', colour: 'ink', size: 2 }

function DrawingView({ node, editor, getPos, selected, updateAttributes, deleteNode }: ReactNodeViewProps) {
  const { width: W, height: H0, widthPct: pct, align } = node.attrs as { width: number; height: number; widthPct: number | null; align: string | null }
  const strokes = node.attrs.strokes as Stroke[]
  const writing = useEditable(editor)
  const [drawing, setDrawing] = useState(false)
  const [tool, setTool] = useState(last.tool)
  const [colour, setColour] = useState(last.colour)
  const [size, setSize] = useState(last.size)
  useEffect(() => void Object.assign(last, { tool, colour, size }), [tool, colour, size])
  // the stroke being drawn, the strokes being rubbed out, the height while its handle is dragged
  const [live, setLive] = useState<Stroke | null>(null)
  const [erasing, setErasing] = useState<Set<number>>(new Set())
  const rubbed = useRef(new Set<number>())
  const [dragH, setDragH] = useState<number | null>(null)
  // while a side or corner handle is dragged: the box's width shown (px), kept as a % when let go
  const [dragW, setDragW] = useState<number | null>(null)
  const frame = useRef<HTMLDivElement>(null)
  const [warn, setWarn] = useState<string | null>(null)
  const [big, setBig] = useState(false)
  const H = dragH ?? H0
  const box = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const doneBtn = useRef<HTMLButtonElement>(null)
  // this block's own undo / redo (the strokes as they were)
  const past = useRef<Stroke[][]>([])
  const future = useRef<Stroke[][]>([])
  const [, bump] = useState(0)
  const asking = useRef(false)
  // Apple Pencil (or any pen) in use: a palm or finger on the pad doesn't draw
  const penSeen = useRef(false)
  const active = useRef<{ id: number; pts: number[]; pressure: boolean } | null>(null)

  // a drawing just put in: straight to drawing
  useEffect(() => {
    if (writing && !strokes.length && Date.now() - openNext < 1500) {
      openNext = 0
      setDrawing(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // reading again: drawing stops
  useEffect(() => void (!writing && setDrawing(false)), [writing])
  useEffect(() => {
    if (!drawing) return setWarn(null)
    // the keyboard goes away (a phone), the focus stays in the note (FolderNotes.tsx useWritingStep)
    doneBtn.current?.focus({ preventScroll: true })
    const away = (e: PointerEvent) => !asking.current && !box.current?.contains(e.target as globalThis.Node) && setDrawing(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (asking.current) return
        // before full size or the note's window take it
        e.stopImmediatePropagation()
        e.preventDefault()
        setDrawing(false)
        return
      }
      const mod = e.metaKey || e.ctrlKey
      if (!mod || !box.current?.contains(document.activeElement)) return
      const k = e.key.toLowerCase()
      if (k === 'z' || k === 'y') {
        e.preventDefault()
        e.stopPropagation()
        if (k === 'y' || e.shiftKey) redo()
        else undo()
      }
    }
    document.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', onKey, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing])

  /** The strokes in the note right now (the props may be a step behind a change just made). */
  const current = () => {
    const pos = getPos()
    const n = typeof pos === 'number' ? editor.state.doc.nodeAt(pos) : null
    return n?.type.name === 'drawing' ? (n.attrs.strokes as Stroke[]) : strokes
  }
  /** New strokes for the block (one step of its undo), kept under its size: simplified more, or refused. */
  const commit = (next: Stroke[], prev = current()) => {
    let out = next
    for (const eps of [1, 2, 3.5]) {
      if (sizeOf(out) <= DRAW_MAX) break
      out = out.map((s) => simplify(s, eps))
    }
    if (sizeOf(out) > DRAW_MAX) {
      setWarn('This drawing is full: start a new one below')
      return false
    }
    setWarn(null)
    past.current.push(prev)
    if (past.current.length > 100) past.current.shift()
    future.current = []
    updateAttributes({ strokes: out })
    return true
  }
  const undo = () => {
    const prev = past.current.pop()
    if (!prev) return
    future.current.push(current())
    updateAttributes({ strokes: prev })
    bump((n) => n + 1)
  }
  const redo = () => {
    const next = future.current.pop()
    if (!next) return
    past.current.push(current())
    updateAttributes({ strokes: next })
    bump((n) => n + 1)
  }
  const clear = async () => {
    if (!current().length) return
    asking.current = true
    const ok = await confirm({ title: 'Clear this drawing?', message: 'All its strokes go (Undo brings them back).', confirmLabel: 'Clear' })
    asking.current = false
    if (ok) commit([])
    doneBtn.current?.focus({ preventScroll: true })
  }

  /** A pointer's spot in the drawing's own units. */
  const at = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect()
    return [((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height] as const
  }
  /** The drawing's units per screen pixel. */
  const scale = () => W / (svg.current?.getBoundingClientRect().width || W)

  const rubOut = (x: number, y: number, into: Set<number>) => {
    const r = 8 * scale()
    let changed = false
    strokes.forEach((s, i) => {
      if (!into.has(i) && touches(s, x, y, r)) (into.add(i), (changed = true))
    })
    return changed
  }

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drawing || !writing || active.current || (e.pointerType === 'mouse' && e.button !== 0)) return
    if (e.pointerType === 'pen') penSeen.current = true
    else if (e.pointerType === 'touch' && penSeen.current) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    const [x, y] = at(e)
    const pressure = e.pointerType === 'pen' && e.pressure > 0
    active.current = { id: e.pointerId, pts: pressure ? [x, y, e.pressure] : [x, y], pressure }
    if (tool === 'eraser') {
      rubbed.current = new Set()
      rubOut(x, y, rubbed.current)
      setErasing(new Set(rubbed.current))
    } else setLive([tool, colour, size, active.current.pts, ...(pressure ? [1 as const] : [])] as Stroke)
  }
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const a = active.current
    if (!a || a.id !== e.pointerId) return
    e.preventDefault()
    e.stopPropagation()
    // every point the pointer passed through since the last frame (smoother lines)
    const evs = (e.nativeEvent.getCoalescedEvents?.() ?? []).length ? e.nativeEvent.getCoalescedEvents() : [e.nativeEvent]
    if (tool === 'eraser') {
      let changed = false
      for (const ev of evs) changed = rubOut(...at(ev), rubbed.current) || changed
      if (changed) setErasing(new Set(rubbed.current))
      return
    }
    for (const ev of evs) {
      const [x, y] = at(ev)
      a.pts.push(x, y, ...(a.pressure ? [ev.pressure || 0.5] : []))
    }
    setLive([tool as Tool, colour, size, [...a.pts], ...(a.pressure ? [1 as const] : [])] as Stroke)
  }
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const a = active.current
    if (!a || a.id !== e.pointerId) return
    e.stopPropagation()
    active.current = null
    if (tool === 'eraser') {
      const gone = rubbed.current
      if (gone.size) commit(current().filter((_, i) => !gone.has(i)))
      rubbed.current = new Set()
      setErasing(new Set())
      return
    }
    setLive(null)
    if (e.type === 'pointercancel' && a.pts.length < 6) return
    commit([...current(), simplify([tool as Tool, colour, size, a.pts, ...(a.pressure ? [1 as const] : [])] as Stroke, 0.4 * scale())])
  }

  // its handles: a side sets the box's width (the strokes scale with it, never stretched), the bottom edge its height
  // (more or less room, in the drawing's units), the corner both
  const startResize = (kind: 'left' | 'right' | 'bottom' | 'corner') => (e: ReactPointerEvent) => {
    const el = frame.current
    const text = el?.closest('.tiptap') as HTMLElement | null
    if (!el || !text) return
    e.preventDefault()
    e.stopPropagation()
    const handle = e.currentTarget as HTMLElement
    handle.setPointerCapture(e.pointerId)
    const css = getComputedStyle(text)
    const room = text.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)
    const r = el.getBoundingClientRect()
    const w0 = r.width
    const h0 = (w0 * H0) / W
    const x0 = e.clientX
    const y0 = e.clientY
    // centred: both sides move, so the hand moves half as far as the width changes
    const k = (kind === 'left' ? -1 : 1) * (align === 'center' ? 2 : 1)
    let w = w0
    let h = H0
    const mv = (ev: PointerEvent) => {
      if (kind !== 'bottom') {
        w = Math.max(Math.min(room, 80), Math.min(room, w0 + (ev.clientX - x0) * k))
        setDragW(w)
      }
      if (kind === 'bottom' || kind === 'corner') {
        // the height on screen it's dragged to, in the drawing's units at the width it has now
        h = clampInt((Math.max(60, h0 + ev.clientY - y0) * W) / w, 40, 8000, H0)
        setDragH(h)
      }
    }
    const end = () => {
      handle.removeEventListener('pointermove', mv)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      setDragW(null)
      setDragH(null)
      const attrs: Record<string, unknown> = {}
      if (Math.abs(w - w0) > 2) attrs.widthPct = widthPct((w / room) * 100)
      if (h !== H0) attrs.height = h
      if (Object.keys(attrs).length) updateAttributes(attrs)
    }
    handle.addEventListener('pointermove', mv)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }
  const handle = (kind: 'left' | 'right' | 'bottom' | 'corner', label: string) => (
    <span className={`drawing__resize drawing__resize--${kind}`} onPointerDown={startResize(kind)} onMouseDown={(e) => (e.preventDefault(), e.stopPropagation())} {...tip(label)} />
  )

  const picked = writing && (selected || drawing)
  return (
    <NodeViewWrapper
      className={`drawing${drawing ? ' is-drawing' : ''}${picked ? ' is-picked' : ''}${align === 'center' ? ' drawing--center' : ''}`}
      data-drag-handle=""
      ref={box}
    >
      {drawing && (
        <div className="drawing__tools" role="toolbar" aria-label="Drawing" onMouseDown={(e) => e.preventDefault()}>
          {(
            [
              ['pen', <LuPenTool key="i" />, 'Pen'],
              ['pencil', <LuPencil key="i" />, 'Pencil'],
              ['marker', <LuHighlighter key="i" />, 'Highlighter'],
              ['eraser', <LuEraser key="i" />, 'Eraser (rubs out whole strokes)'],
            ] as const
          ).map(([t, icon, label]) => (
            <button key={t} type="button" className={tool === t ? 'is-on' : ''} aria-pressed={tool === t} onClick={() => setTool(t)} {...tip(label)}>
              {icon}
            </button>
          ))}
          <i className="drawing__sep" />
          {COLOUR_NAMES.map((c) => (
            <button
              key={c}
              type="button"
              className={`drawing__colour${colour === c ? ' is-on' : ''}`}
              style={{ ['--c' as string]: COLOURS[c] }}
              aria-pressed={colour === c}
              onClick={() => (setColour(c), tool === 'eraser' && setTool('pen'))}
              {...tip(c === 'ink' ? 'Ink' : c[0].toUpperCase() + c.slice(1))}
            />
          ))}
          <i className="drawing__sep" />
          {[1, 2, 3].map((n) => (
            <button key={n} type="button" className={size === n ? 'is-on' : ''} aria-pressed={size === n} onClick={() => setSize(n)} {...tip(['Thin', 'Medium', 'Thick'][n - 1])}>
              <span className="drawing__dot" style={{ width: 2 + n * 3, height: 2 + n * 3 }} />
            </button>
          ))}
          <i className="drawing__sep" />
          <button type="button" onClick={undo} disabled={!past.current.length} {...tip('Undo')}>
            <LuUndo2 />
          </button>
          <button type="button" onClick={redo} disabled={!future.current.length} {...tip('Redo')}>
            <LuRedo2 />
          </button>
          <button type="button" onClick={() => void clear()} disabled={!strokes.length} {...tip('Clear the drawing')}>
            <LuBrush />
          </button>
          <button type="button" className={align !== 'center' ? 'is-on' : ''} onClick={() => updateAttributes({ align: null })} {...tip('Align left')}>
            <LuAlignLeft />
          </button>
          <button type="button" className={align === 'center' ? 'is-on' : ''} onClick={() => updateAttributes({ align: 'center' })} {...tip('Centre')}>
            <LuAlignCenter />
          </button>
          <button type="button" onClick={() => deleteNode()} {...tip('Delete the drawing')}>
            <LuTrash2 />
          </button>
          <button ref={doneBtn} type="button" className="drawing__done" onClick={() => setDrawing(false)} aria-label="Done drawing (Esc)">
            <LuCheck /> Done
          </button>
          {warn && <span className="drawing__warn">{warn}</span>}
        </div>
      )}
      <div className="drawing__frame" ref={frame} style={{ width: dragW != null ? `${dragW}px` : pct ? `${pct}%` : undefined }}>
      <div
        className={`drawing__pad${!strokes.length ? ' is-empty' : ''}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onMouseDown={(e) => drawing && e.preventDefault()}
        // a tap (not a scroll) starts drawing while writing; while reading it opens it bigger
        onClick={() => (editor.isEditable ? !drawing && setDrawing(true) : strokes.length && setBig(true))}
        data-tool={drawing ? tool : undefined}
      >
        <DrawingSvg ref={svg} width={W} height={H} strokes={strokes} live={live} faded={erasing} />
        {!strokes.length && !live && writing && !drawing && <span className="drawing__hint">Tap to draw</span>}
      </div>
      {writing && !drawing && (
        <button type="button" className="drawing__draw" onMouseDown={(e) => e.preventDefault()} onClick={() => setDrawing(true)}>
          <LuPenTool /> Draw
        </button>
      )}
      {writing && (
        <>
          {handle('left', 'Drag to change the width')}
          {handle('right', 'Drag to change the width')}
          {handle('bottom', 'Drag to change the height')}
          {handle('corner', 'Drag to change the size')}
        </>
      )}
      {!writing && strokes.length > 0 && (
        <button type="button" className="drawing__expand" onClick={() => setBig(true)} {...tip('View bigger')}>
          <LuExpand />
        </button>
      )}
      </div>
      {big && <DrawingLightbox width={W} height={H0} strokes={strokes} onClose={() => setBig(false)} />}
    </NodeViewWrapper>
  )
}

/** The strokes as an SVG of filled paths, scaled to its width. */
const DrawingSvg = memo(function DrawingSvg({
  width,
  height,
  strokes,
  live,
  faded,
  ref,
}: {
  width: number
  height: number
  strokes: Stroke[]
  live?: Stroke | null
  /** being rubbed out: nearly gone */
  faded?: Set<number>
  ref?: React.Ref<SVGSVGElement>
}) {
  // the finished strokes' paths, worked out once
  const paths = useMemo(() => strokes.map((s) => strokePath(s)), [strokes])
  const path = (s: Stroke, d: string, key: number | string, dim = false) => (
    <path key={key} d={d} style={{ fill: COLOURS[s[1]] ?? COLOURS.ink }} fillOpacity={OPACITY[s[0]] * (dim ? 0.2 : 1)} />
  )
  return (
    <svg ref={ref} className="drawing__svg" viewBox={`0 0 ${width} ${height}`} style={{ aspectRatio: `${width} / ${height}` }} aria-hidden>
      {strokes.map((s, i) => path(s, paths[i], i, faded?.has(i)))}
      {live && path(live, strokePath(live, false), 'live')}
    </svg>
  )
})

/** The drawing bigger, over everything: a click outside, Esc or Back closes it. */
function DrawingLightbox({ width, height, strokes, onClose }: { width: number; height: number; strokes: Stroke[]; onClose: () => void }) {
  useBackStep(onClose)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal(
    <div className="img-lightbox" role="dialog" aria-modal="true" aria-label="Drawing" onClick={onClose}>
      <div className="drawing-lightbox" style={{ aspectRatio: `${width} / ${height}`, ['--ar' as string]: width / height }} onClick={(e) => e.stopPropagation()}>
        <DrawingSvg width={width} height={height} strokes={strokes} />
      </div>
      <button type="button" className="icon-btn img-lightbox__close" onClick={onClose} aria-label="Close">
        <LuX />
      </button>
    </div>,
    document.body,
  )
}
