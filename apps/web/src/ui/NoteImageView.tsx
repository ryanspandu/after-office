import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Image } from '@tiptap/extension-image'
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import { LuAlignCenter, LuAlignLeft, LuExpand, LuTrash2, LuX } from 'react-icons/lu'
import { useBackStep } from '../state/useBackStep'
import { tip } from './Tooltip'

// A picture in a note (ui/FolderNotes.tsx): stored by the server (work/noteImages.ts), only its own ones are read from
// HTML. Picked while writing: handles to resize it (its width kept in % of the text's width), and a small bar with
// sizes, alignment, View full size and Delete. While reading, a click opens it full size.

/** A width the note may keep: a percentage up to 100, or pixels (anything else, e.g. a style, is dropped). */
export const safeWidth = (v: string | null | undefined) => {
  const m = v?.trim().match(/^(\d{1,4}(?:\.\d+)?)(%|px)$/)
  if (!m) return null
  const n = Math.round(Number(m[1]))
  if (m[2] === '%') return n >= 5 && n <= 100 ? `${n}%` : null
  return n >= 24 && n <= 4000 ? `${n}px` : null
}

export const NoteImage = Image.extend({
  parseHTML: () => [{ tag: 'img[src^="/api/note-images/"]' }],
  addAttributes() {
    return {
      ...this.parent?.(),
      // shown as style="width: …" (data-width keeps it plain to read back); none: its own size, at most the text's width
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => safeWidth(el.getAttribute('data-width') ?? el.style.width),
        renderHTML: (a: { width?: string | null }) => (a.width ? { 'data-width': a.width, style: `width: ${a.width}` } : {}),
      },
      height: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      align: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.getAttribute('data-align') === 'center' ? 'center' : null),
        renderHTML: (a: { align?: string | null }) => (a.align ? { 'data-align': a.align } : {}),
      },
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(NoteImageView)
  },
}).configure({ allowBase64: false })

const SIZES = [
  { label: 'S', width: '25%', tip: 'Small (a quarter of the width)' },
  { label: 'M', width: '50%', tip: 'Medium (half the width)' },
  { label: 'L', width: '75%', tip: 'Large' },
  { label: 'Full', width: '100%', tip: 'Full width' },
]

function NoteImageView({ node, editor, selected, updateAttributes, deleteNode }: ReactNodeViewProps) {
  const { src, alt, width, align } = node.attrs as { src: string; alt?: string; width?: string | null; align?: string | null }
  const img = useRef<HTMLImageElement>(null)
  const [big, setBig] = useState(false)
  // while dragging a handle: the width shown (px), saved as a % when let go
  const [dragW, setDragW] = useState<number | null>(null)
  const writing = editor.isEditable

  const startResize = (side: 'left' | 'right') => (e: ReactPointerEvent) => {
    const el = img.current
    const text = el?.closest('.tiptap') as HTMLElement | null
    if (!el || !text) return
    e.preventDefault()
    e.stopPropagation()
    const handle = e.currentTarget as HTMLElement
    handle.setPointerCapture(e.pointerId)
    const room = text.clientWidth - parseFloat(getComputedStyle(text).paddingLeft) - parseFloat(getComputedStyle(text).paddingRight)
    const from = el.getBoundingClientRect().width
    const x0 = e.clientX
    // centred: both sides move, so the hand moves half as far as the width changes
    const k = (side === 'left' ? -1 : 1) * (align === 'center' ? 2 : 1)
    let w = from
    const move = (ev: PointerEvent) => {
      w = Math.max(40, Math.min(room, from + (ev.clientX - x0) * k))
      setDragW(w)
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      setDragW(null)
      if (Math.abs(w - from) > 2) updateAttributes({ width: safeWidth(`${(w / room) * 100}%`) })
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  const picked = selected && writing
  return (
    <NodeViewWrapper className={`note-img${align === 'center' ? ' note-img--center' : ''}${picked ? ' is-picked' : ''}`} data-drag-handle="">
      <span className="note-img__frame" style={{ width: dragW != null ? `${dragW}px` : (width ?? undefined) }}>
        <img
          ref={img}
          src={src}
          alt={alt ?? ''}
          draggable={false}
          // reading: a click opens it full size
          onClick={() => !editor.isEditable && setBig(true)}
        />
        {picked && (
          <>
            <span className="note-img__handle note-img__handle--left" onPointerDown={startResize('left')} onMouseDown={(e) => (e.preventDefault(), e.stopPropagation())} aria-hidden />
            <span className="note-img__handle note-img__handle--right" onPointerDown={startResize('right')} onMouseDown={(e) => (e.preventDefault(), e.stopPropagation())} aria-hidden />
            <span className="note-img__handle note-img__handle--corner" onPointerDown={startResize('right')} onMouseDown={(e) => (e.preventDefault(), e.stopPropagation())} aria-hidden />
            <span className="note-img__bar" role="toolbar" aria-label="Picture" onMouseDown={(e) => e.preventDefault()}>
              {SIZES.map((s) => (
                <button key={s.width} type="button" className={width === s.width ? 'is-on' : ''} onClick={() => updateAttributes({ width: s.width })} {...tip(s.tip)}>
                  {s.label}
                </button>
              ))}
              <button type="button" className={!width ? 'is-on' : ''} onClick={() => updateAttributes({ width: null })} {...tip('Original size (at most the width of the text)')}>
                1:1
              </button>
              <i className="note-img__sep" />
              <button type="button" className={align !== 'center' ? 'is-on' : ''} onClick={() => updateAttributes({ align: null })} {...tip('Align left')}>
                <LuAlignLeft />
              </button>
              <button type="button" className={align === 'center' ? 'is-on' : ''} onClick={() => updateAttributes({ align: 'center' })} {...tip('Centre')}>
                <LuAlignCenter />
              </button>
              <i className="note-img__sep" />
              <button type="button" onClick={() => setBig(true)} {...tip('View full size')}>
                <LuExpand />
              </button>
              <button type="button" onClick={() => deleteNode()} {...tip('Delete the picture')}>
                <LuTrash2 />
              </button>
            </span>
          </>
        )}
      </span>
      {big && <Lightbox src={src} alt={alt ?? ''} onClose={() => setBig(false)} />}
    </NodeViewWrapper>
  )
}

/** The picture full size, over everything: a click outside, Esc or Back closes it. */
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useBackStep(onClose)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // before the note's window takes it
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal(
    <div className="img-lightbox" role="dialog" aria-modal="true" aria-label={alt || 'Picture'} onClick={onClose}>
      <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
      <button type="button" className="icon-btn img-lightbox__close" onClick={onClose} aria-label="Close">
        <LuX />
      </button>
    </div>,
    document.body,
  )
}
