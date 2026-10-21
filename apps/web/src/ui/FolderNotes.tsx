import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { dateTime } from './when'
import { markdownToHtml } from '@after-office/shared'
import { getParam, openUrl, setUrl, useParam } from '../state/url'
import { MOBILE, useMediaQuery } from '../state/useMediaQuery'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TaskList } from '@tiptap/extension-task-list'
import { TaskItem } from '@tiptap/extension-task-item'
import { Placeholder } from '@tiptap/extensions'
import { Color, FontSize, TextStyle } from '@tiptap/extension-text-style'
import { Highlight } from '@tiptap/extension-highlight'
import { TextAlign } from '@tiptap/extension-text-align'
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details'
import { DragHandle } from '@tiptap/extension-drag-handle-react'
import { NoteImage } from './NoteImageView'
import { insertDrawing, NoteDrawing } from './NoteDrawing'
import { Select } from './Select'
import CreatableSelect from 'react-select/creatable'
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { Callout, LinkKey, NoteCodeBlock, NoteTable } from './NoteEditorBlocks'
import { createSlashBridge, SlashCommand, SlashMenu } from './NoteSlash'
import { useBackStep } from '../state/useBackStep'
import { api } from '../state/auth'
import {
  LuAlignCenter,
  LuAlignLeft,
  LuAlignRight,
  LuArrowDownToLine,
  LuArrowLeftToLine,
  LuArrowRightToLine,
  LuArrowUpToLine,
  LuBaseline,
  LuCodeXml,
  LuColumns3,
  LuExternalLink,
  LuLightbulb,
  LuMaximize2,
  LuMinimize2,
  LuPanelTop,
  LuRows3,
  LuTable,
  LuTrash2,
  LuUnlink,
  LuBold,
  LuCheck,
  LuPenTool,
  LuChevronsDownUp,
  LuHeading3,
  LuGripVertical,
  LuHighlighter,
  LuImagePlus,
  LuMinus,
  LuSquareCheck,
  LuCode,
  LuEllipsis,
  LuHeading1,
  LuHeading2,
  LuItalic,
  LuLink,
  LuList,
  LuListOrdered,
  LuLoader,
  LuQuote,
  LuRedo2,
  LuStrikethrough,
  LuUnderline,
  LuUndo2,
} from 'react-icons/lu'

// The rich text editor (TipTap) of the owner's notes (ui/OwnerNotes.tsx: the Notes window, a folder's details → Notes).
// Loaded only when a note is opened.

// ── pictures in a note: pasted, dropped or picked; stored by the server (work/noteImages.ts), shown from their URL ──

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const IMAGE_MAX = 10 * 1024 * 1024
const imagesOf = (files: FileList | null | undefined) => [...(files ?? [])].filter((f) => f.type.startsWith('image/'))

/** One picture to the server: its URL. */
async function uploadImage(file: File) {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error(`${file.name || 'That picture'}: only PNG, JPEG, GIF or WebP`)
  if (file.size > IMAGE_MAX) throw new Error(`${file.name || 'That picture'} is bigger than 10 MB`)
  const r = await api('/api/note-images', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name || 'image') }, body: file })
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Could not upload the picture')
  return ((await r.json()) as { url: string }).url
}

/** What a note's window can do to its text from outside the editor (Ask Marcus's Insert / Replace note). */
export interface RichNotesApi {
  /** Markdown put in where the owner last was in the text (what was selected goes), or at the end; saved as typing is */
  insert: (markdown: string) => void
  /** the whole text becomes this Markdown */
  replace: (markdown: string) => void
  /** the text as it is now (HTML), and back to some earlier one (Undo of Marcus's edit) */
  html: () => string
  setHtml: (html: string) => void
}

/**
 * The rich text editor with its toolbar, saved as you type (a folder's notes, the owner's notes in Reports). `save`
 * stores the HTML ('' when empty) and says when it was saved.
 */
export function RichNotes({
  initial,
  initialAt,
  placeholder,
  save: store,
  autofocus = true,
  onEdit,
  viewFirst = false,
  onReady,
}: {
  initial: string
  initialAt: number | null
  placeholder: string
  save: (html: string) => Promise<number | null>
  autofocus?: boolean
  /** every change, right away (the save waits a moment): whether the text is empty now */
  onEdit?: (empty: boolean) => void
  /** opens to read (scrolls, can't be changed) with Edit to write; an empty one opens to write */
  viewFirst?: boolean
  /** its text changed from outside (null: gone) */
  onReady?: (api: RichNotesApi | null) => void
}) {
  const [editing, setEditing] = useState(!viewFirst || !initial.trim())
  const [state, setState] = useState<'saved' | 'saving' | 'error'>('saved')
  // when they were last saved (none yet: nothing written)
  const [savedAt, setSavedAt] = useState(initialAt)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<string | null>(null)

  const save = async (html: string) => {
    setState('saving')
    try {
      setSavedAt(await store(html))
      setError(null)
      if (pending.current === html) pending.current = null
      setState(pending.current ? 'saving' : 'saved')
    } catch (e) {
      setError((e as Error).message)
      setState('error')
    }
  }

  // the owner has been in the text: an insert goes where they were (else at the end)
  const touched = useRef(false)
  // pictures on their way up: where each goes (kept in step with the text typed meanwhile), and how many there are
  const [uploading, setUploading] = useState(0)
  const addImages = useRef<(files: File[], at?: number) => void>(() => {})
  // the picture picker (the toolbar's button, the "/" menu's Image)
  const picker = useRef<HTMLInputElement>(null)
  const pickImage = () => picker.current?.click()
  // the "/" menu (NoteSlash.tsx) and the link popover (Cmd/Ctrl+K), opened from inside the editor
  const [slash] = useState(createSlashBridge)
  slash.setImage(pickImage)
  const [linking, setLinking] = useState(false)
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // links: the web and e-mail only, opened in a new tab (while writing: Cmd/Ctrl+click); found as they're typed
        // or pasted
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: 'https',
          isAllowedUri: (url) => SAFE_LINK.test(url),
          shouldAutoLink: (url) => SAFE_LINK.test(url) || !/^[a-z][\w+.-]*:/i.test(url),
          HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer nofollow' },
        },
        // the coloured one below (NoteEditorBlocks.ts)
        codeBlock: false,
        // all six (Cmd/Ctrl+Alt+1…6; "#" to "######" in Markdown)
        heading: { levels: [1, 2, 3, 4, 5, 6] },
      }),
      NoteCodeBlock,
      Callout,
      NoteTable,
      TableRow,
      TableHeader,
      TableCell,
      SlashCommand.configure({ bridge: slash }),
      LinkKey.configure({ open: () => setLinking(true) }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TextStyle,
      FontSize,
      Color,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      // a collapsible block: its summary line, and what folds away under it (kept open / shut as it was left)
      Details.configure({ persist: true }),
      DetailsSummary,
      DetailsContent,
      NoteImage,
      NoteDrawing,
      // the empty note: its own hint; an empty line while writing: the "/" menu's
      Placeholder.configure({
        placeholder: ({ editor: e, node }) => (e.isEmpty ? `${placeholder} Type / for commands` : node.type.name === 'paragraph' ? 'Type / for commands' : ''),
      }),
    ],
    content: initial,
    editable: editing,
    onFocus: () => void (touched.current = true),
    editorProps: {
      // a link while writing: Cmd/Ctrl+click opens it (while reading, a click does: the browser's own)
      handleClick: (view, _pos, event) => {
        const a = (event.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null
        if (!a || !view.editable || !(event.metaKey || event.ctrlKey) || !SAFE_LINK.test(a.href)) return false
        window.open(a.href, '_blank', 'noopener,noreferrer')
        return true
      },
      // a pasted picture goes up and in; text pasted with it is pasted as usual
      handlePaste: (_view, event) => {
        const files = imagesOf(event.clipboardData?.files)
        if (!files.length) return false
        addImages.current(files)
        return !event.clipboardData?.getData('text/plain')
      },
      // dropped: where it was let go
      handleDrop: (view, event, _slice, moved) => {
        const files = moved ? [] : imagesOf(event.dataTransfer?.files)
        if (!files.length) return false
        event.preventDefault()
        addImages.current(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos)
        return true
      },
    },
    autofocus: autofocus && !initial.trim() ? 'end' : false,
    onUpdate: ({ editor: e }) => {
      // an empty editor is "<p></p>": nothing
      const html = e.isEmpty ? '' : e.getHTML()
      onEdit?.(e.isEmpty)
      pending.current = html
      setState('saving')
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void save(html), 700)
    },
  })

  // closing the panel right after typing: what's typed is kept
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      if (pending.current !== null) void save(pending.current)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  useEffect(() => editor?.setEditable(editing), [editor, editing])
  const spots = useRef(new Set<{ pos: number }>())
  useEffect(() => {
    if (!editor) return
    const follow = ({ transaction }: { transaction: { mapping: { map: (pos: number) => number } } }) => spots.current.forEach((s) => (s.pos = transaction.mapping.map(s.pos)))
    editor.on('transaction', follow)
    return () => void editor.off('transaction', follow)
  }, [editor])
  addImages.current = (files, at) => {
    if (!editor) return
    for (const file of files) {
      const spot = { pos: at ?? editor.state.selection.to }
      spots.current.add(spot)
      setUploading((n) => n + 1)
      uploadImage(file)
        .then((src) => {
          // the editor's gone meanwhile (the note closed): nothing to put it in
          if (editor.isDestroyed) return
          editor.chain().insertContentAt(Math.min(spot.pos, editor.state.doc.content.size), { type: 'image', attrs: { src, alt: file.name.replace(/\.\w+$/, '') } }).run()
        })
        .catch((e: Error) => {
          setError(e.message)
          setState('error')
        })
        .finally(() => {
          spots.current.delete(spot)
          setUploading((n) => n - 1)
        })
    }
  }

  // also while reading (not editable): the commands change the text all the same, and onUpdate saves it
  useEffect(() => {
    if (!editor || !onReady) return
    onReady({
      insert: (md) => {
        const html = markdownToHtml(md)
        const { from, to } = editor.state.selection
        const end = editor.state.doc.content.size
        editor.chain().insertContentAt(touched.current ? { from, to } : end, html).run()
      },
      replace: (md) => void editor.commands.setContent(markdownToHtml(md), { emitUpdate: true }),
      html: () => editor.getHTML(),
      setHtml: (html) => void editor.commands.setContent(html, { emitUpdate: true }),
    })
    return () => onReady(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])
  // right in the tap (a phone opens its keyboard only for a focus made there); `at`: where the text was tapped
  const startEditing = (at?: number) => {
    editor?.setEditable(true)
    editor?.commands.focus(at ?? 'end')
    setEditing(true)
  }
  /** A click (a tap) on the note while reading starts writing, right where it was clicked (no Edit button). A click on
   *  a link, a picture, a drawing or a checkbox still does what it does; a scroll isn't a tap (no click), and text
   *  being selected (to copy) isn't either. */
  const tapToWrite = (e: React.MouseEvent) => {
    if (editing || !editor) return
    if ((e.target as HTMLElement).closest('a, img, input, button, .node-image, .node-drawing, .note-img, [data-type="drawing"]')) return
    if (!(window.getSelection()?.isCollapsed ?? true)) return
    const hit = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })
    startEditing(hit?.pos)
  }
  // back to reading (viewFirst only): Done on a computer; ✓, Back or leaving the editor on a phone
  const stopEditing = () => {
    if (!viewFirst) return
    editor?.commands.blur()
    setEditing(false)
    setFull('off')
  }
  const writing = useWritingStep(stopEditing)
  const [full, setFull, fullBox, fullHold, fullHoldHeight] = useFullSize()
  // phones have their own whole-screen writing (useWritingStep): a window narrowed to one leaves full size
  const phone = useMediaQuery(MOBILE)
  useEffect(() => void (phone && setFull('off')), [phone]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`fnotes${editing ? '' : ' fnotes--view'}`} ref={writing.ref} onFocus={writing.onFocus} onBlur={writing.onBlur}>
      <div className="fnotes__meta">
        {editing ? (
          editor && <History editor={editor} />
        ) : (
          // no button: a click (a tap) on the note starts writing (tapToWrite)
          <span className="muted fnotes__tap-hint">{phone ? 'Tap' : 'Click'} the note to edit</span>
        )}
        <span className="grow" />
        <span className={`fnotes__state muted${state === 'error' ? ' danger-text' : ''}`}>
          {uploading > 0 && state !== 'error' ? (
            <>
              <LuLoader className="spin" /> Uploading {uploading === 1 ? 'picture' : `${uploading} pictures`}…
            </>
          ) : state === 'saving' ? (
            <>
              <LuLoader className="spin" /> Saving…
            </>
          ) : state === 'error' ? (
            error
          ) : (
            <>
              <LuCheck /> Saved {savedAt !== null && <span className="fnotes__at">· {dateTime(savedAt)}</span>}
            </>
          )}
        </span>
        {viewFirst && editing && (
          <button type="button" className="small ghost fnotes__stop" onMouseDown={(e) => e.preventDefault()} onClick={stopEditing}>
            Done
          </button>
        )}
      </div>
      <input
        ref={picker}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(e) => {
          addImages.current([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      {/* the toolbar sits right on top of the text box, as one piece; full size (computers): the two of them fill the
          window (beside Ask Marcus's panel when it's open, styles/notes.css) */}
      <div ref={fullBox} className={`fnotes__box${full !== 'off' ? ' fnotes__box--full' : ''}${full === 'leaving' ? ' is-leaving' : ''}`}>
        {editing && (
          <div className="fnotes__bar">
            {editor && (
              <Toolbar
                editor={editor}
                onDone={stopEditing}
                onPickImage={pickImage}
                onLink={() => setLinking(true)}
                full={full === 'on'}
                onFull={() => setFull(full === 'on' ? 'leaving' : 'on')}
              />
            )}
          </div>
        )}
        <div className="fnotes__editor" onClick={tapToWrite}>
          {/* like Notion: a grip beside the block under the pointer drags it (a paragraph, a list item, a section…) */}
          {editor && editing && (
            <DragHandle editor={editor}>
              <div className="fnotes__grip" aria-label="Drag to move">
                <LuGripVertical />
              </div>
            </DragHandle>
          )}
          <EditorContent editor={editor} />
        </div>
      </div>
      {/* full size: the box's room in the note, kept while it's out */}
      {full !== 'off' && <div ref={fullHold} className="fnotes__hold" style={{ height: fullHoldHeight }} aria-hidden />}
      {editor && editing && (
        <>
          <SlashMenu bridge={slash} />
          <TableBar editor={editor} />
          {linking && <LinkPop editor={editor} onClose={() => setLinking(false)} />}
        </>
      )}
    </div>
  )
}

/** A link the notes keep: the web or an e-mail address. */
const SAFE_LINK = /^(https?:\/\/|mailto:)/i

/**
 * Full size (computers): 'on', or 'leaving' while it shrinks back (its box clipped from the window to its place in
 * the note, and the other way in). Esc or Back leave it first (before the note's window takes them); with reduced
 * motion it goes at once.
 */
function useFullSize() {
  const [full, set] = useState<'off' | 'on' | 'leaving'>('off')
  // the box (toolbar + text): it grows out of where it sits in the note to the window, and shrinks back into it
  const box = useRef<HTMLDivElement>(null)
  const home = useRef<DOMRect | null>(null)
  // its room in the note while it's out (the note window keeps its size, and the box has a place to go back to)
  const hold = useRef<HTMLDivElement>(null)
  const [holdHeight, setHoldHeight] = useState(0)
  const was = useRef(full)
  const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  /** the box's place in the note, as a clip of the full-size box (an inset from each side) */
  const clipAt = (r: DOMRect, to: DOMRect) => `inset(${r.top - to.top}px ${to.right - r.right}px ${to.bottom - r.bottom}px ${r.left - to.left}px round 14px)`
  // Ask Marcus's panel beside it (styles/notes.css): at the window's right edge while it's full size, back in the note
  // after; it moves along with the box, in step (same time, same curve)
  const panelOf = () => box.current?.closest('.note-modal--assist')?.querySelector<HTMLElement>(':scope > .note-assist') ?? null
  const panelFrom = useRef<DOMRect | null>(null)
  const ENTER = { duration: 280, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
  const LEAVE = { duration: 240, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }
  /** the panel from where it was to where it is now */
  const movePanel = (timing: KeyframeAnimationOptions) => {
    const panel = panelOf()
    const from = panelFrom.current
    panelFrom.current = null
    if (!panel || !from) return
    const to = panel.getBoundingClientRect()
    // above the box while they cross
    panel.classList.add('is-moving')
    const a = panel.animate(
      [
        { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`, width: `${from.width}px`, height: `${from.height}px` },
        { transform: 'translate(0, 0)', width: `${to.width}px`, height: `${to.height}px` },
      ],
      timing,
    )
    const done = () => panel.classList.remove('is-moving')
    a.onfinish = done
    a.oncancel = done
  }
  const setFull = (v: 'off' | 'on' | 'leaving') => {
    if (v === 'on' && box.current) {
      home.current = box.current.getBoundingClientRect()
      setHoldHeight(home.current.height)
    }
    if (v === 'on' || v === 'leaving') panelFrom.current = panelOf()?.getBoundingClientRect() ?? null
    set(v === 'leaving' && still() ? 'off' : v)
  }
  useLayoutEffect(() => {
    const el = box.current
    const before = was.current
    was.current = full
    if (!el || !home.current || still()) return
    // back in its place: it fades in there (the shrinking one faded out on its way)
    if (full === 'off' && before === 'leaving') {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' })
      return
    }
    if (full === 'on' && before === 'off') {
      el.animate([{ clipPath: clipAt(home.current, el.getBoundingClientRect()) }, { clipPath: 'inset(0px 0px 0px 0px round 0px)' }], ENTER)
      movePanel(ENTER)
    } else if (full === 'leaving') {
      // the panel goes back into the note now (styles/notes.css: not while leaving), moving there as the box shrinks
      movePanel(LEAVE)
      // where its room is now (the note may have scrolled since)
      const to = hold.current?.getBoundingClientRect() ?? home.current
      const a = el.animate(
        [
          { clipPath: 'inset(0px 0px 0px 0px round 0px)', opacity: 1 },
          { opacity: 1, offset: 0.55 },
          { clipPath: clipAt(to, el.getBoundingClientRect()), opacity: 0 },
        ],
        { ...LEAVE, fill: 'forwards' },
      )
      a.onfinish = () => set('off')
      // a tab in the background doesn't play it: gone after its time anyway
      const t = setTimeout(() => set('off'), 340)
      return () => (clearTimeout(t), a.cancel())
    }
  }, [full])
  useEffect(() => {
    if (full !== 'leaving' || !still()) return
    set('off')
  }, [full])
  const shown = full !== 'off'
  useBackStep(() => setFull('leaving'), shown)
  useEffect(() => {
    if (!shown) return
    const onKey = (e: KeyboardEvent) => {
      // the "/" menu, a link being written, a picture full size…: theirs first
      if (e.key !== 'Escape' || document.querySelector('.slash-menu, .link-pop, .img-lightbox, .rs__menu, .drawing.is-drawing')) return
      e.stopImmediatePropagation()
      setFull('leaving')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown])
  return [full, setFull, box, hold, holdHeight] as const
}

/** Where a popover goes: under (or above) a spot on the screen, kept inside the window. */
function placeBelow(r: { top: number; bottom: number; left: number }, w: number, h: number) {
  const vh = window.visualViewport?.height ?? window.innerHeight
  const below = r.bottom + 6
  const top = below + h > vh - 8 && r.top - 6 - h > 8 ? r.top - 6 - h : Math.max(8, Math.min(below, vh - h - 8))
  return { top, left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) }
}

/**
 * Cmd/Ctrl+K or the toolbar's Link: the address of the link under the caret (or of the text picked), in a small field
 * under it. Enter keeps it, an empty one removes it; text not picked gets the address itself as its words.
 */
function LinkPop({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const prev = (editor.getAttributes('link').href as string | undefined) ?? ''
  const [url, setUrl] = useState(prev)
  const [bad, setBad] = useState(false)
  const box = useRef<HTMLFormElement>(null)
  const [at, setAt] = useState({ top: -9999, left: -9999 })
  useLayoutEffect(() => {
    const c = editor.view.coordsAtPos(editor.state.selection.from)
    if (box.current) setAt(placeBelow(c, box.current.offsetWidth, box.current.offsetHeight))
  }, [editor])
  useEffect(() => {
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && onClose()
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [onClose])
  const close = () => (onClose(), editor.commands.focus())
  const apply = () => {
    const v = url.trim()
    const chain = () => editor.chain().focus().extendMarkRange('link')
    if (!v) return chain().unsetLink().run(), onClose()
    // "aftrn.com" → https://…, "me@x.co" → mailto:…
    const href = SAFE_LINK.test(v) ? v : /^[^\s@/:]+@[^\s@/]+\.[^\s@/]+$/.test(v) ? `mailto:${v}` : /^[a-z][\w+.-]*:/i.test(v) ? '' : `https://${v}`
    if (!href) return setBad(true)
    if (editor.state.selection.empty && !editor.isActive('link')) {
      editor.chain().focus().insertContent({ type: 'text', text: v, marks: [{ type: 'link', attrs: { href } }] }).run()
    } else chain().setLink({ href }).run()
    onClose()
  }
  // inside the note (not on <body>): its field taking the focus is still writing (useWritingStep)
  return (
    <form
      ref={box}
      className="link-pop ui-pop"
      style={at}
      onSubmit={(e) => (e.preventDefault(), apply())}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        close()
      }}
    >
      <input
        autoFocus
        value={url}
        onChange={(e) => (setUrl(e.target.value), setBad(false))}
        placeholder="Paste or type a link"
        aria-label="Link address"
        aria-invalid={bad}
        inputMode="url"
        autoCapitalize="off"
        spellCheck={false}
      />
      <button type="submit" className="fnotes__btn" aria-label="Save link" data-tip="Save (Enter)">
        <LuCheck />
      </button>
      {prev && (
        <>
          <a className="fnotes__btn" href={SAFE_LINK.test(prev) ? prev : undefined} target="_blank" rel="noopener noreferrer nofollow" aria-label="Open link" data-tip="Open">
            <LuExternalLink />
          </a>
          <button type="button" className="fnotes__btn" aria-label="Remove link" data-tip="Remove" onClick={() => (editor.chain().focus().extendMarkRange('link').unsetLink().run(), onClose())}>
            <LuUnlink />
          </button>
        </>
      )}
      {bad && <span className="link-pop__bad">Only web (https://) or e-mail links</span>}
    </form>
  )
}

/** The caret in a table: rows, columns, its header and the table itself, in a small bar above it. */
function TableBar({ editor }: { editor: Editor }) {
  const table = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e.isEditable || !e.isActive('table')) return null
      const $from = e.state.selection.$from
      for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'table') return { pos: $from.before(d), header: $from.node(d).firstChild?.firstChild?.type.name === 'tableHeader' }
      return null
    },
  })
  const bar = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const pos = table?.pos
  useLayoutEffect(() => {
    if (pos === undefined) return setAt(null)
    const place = () => {
      const dom = editor.view.nodeDOM(pos) as HTMLElement | null
      const scroller = dom?.closest('.fnotes__editor')
      if (!dom || !scroller || !bar.current) return
      const r = dom.getBoundingClientRect()
      const s = scroller.getBoundingClientRect()
      const h = bar.current.offsetHeight
      // above the table, kept in the text box while it scrolls (over the table's top rows when that's out of sight)
      const top = Math.min(Math.max(r.top - h - 6, s.top + 4), r.bottom - h)
      if (r.bottom < s.top || r.top > s.bottom) return setAt(null)
      setAt({ top, left: Math.max(8, Math.min(Math.max(r.left, s.left + 4), window.innerWidth - bar.current.offsetWidth - 8)) })
    }
    place()
    editor.on('transaction', place)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      editor.off('transaction', place)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [editor, pos])
  if (!table) return null
  const btn = (label: string, icon: React.ReactNode, fn: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>, extra = '') => (
    <button type="button" className={`fnotes__btn${extra}`} aria-label={label} data-tip={label} onMouseDown={(e) => e.preventDefault()} onClick={() => fn(editor.chain().focus()).run()}>
      {icon}
    </button>
  )
  return (
    <div ref={bar} className="table-bar" role="toolbar" aria-label="Table" style={at ?? { top: -9999, left: -9999 }}>
      {btn('Add row above', <LuArrowUpToLine />, (c) => c.addRowBefore())}
      {btn('Add row below', <LuArrowDownToLine />, (c) => c.addRowAfter())}
      {btn('Delete row', <LuRows3 />, (c) => c.deleteRow(), ' is-danger')}
      <i className="table-bar__sep" />
      {btn('Add column left', <LuArrowLeftToLine />, (c) => c.addColumnBefore())}
      {btn('Add column right', <LuArrowRightToLine />, (c) => c.addColumnAfter())}
      {btn('Delete column', <LuColumns3 />, (c) => c.deleteColumn(), ' is-danger')}
      <i className="table-bar__sep" />
      {btn(table.header ? 'Header row off' : 'Header row on', <LuPanelTop />, (c) => c.toggleHeaderRow(), table.header ? ' is-on' : '')}
      {btn('Delete table', <LuTrash2 />, (c) => c.deleteTable(), ' is-danger')}
    </div>
  )
}

function Toolbar({
  editor,
  onDone,
  onPickImage,
  onLink,
  full,
  onFull,
}: {
  editor: Editor
  onDone: () => void
  onPickImage: () => void
  onLink: () => void
  /** full size (computers): on, and the button that turns it on / off */
  full: boolean
  onFull: () => void
}) {
  const phone = useMediaQuery(MOBILE)
  // re-render the buttons as the selection's marks change
  const on = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      block: blockOf(e),
      size: sizeOf(e),
      color: (e.getAttributes('textStyle').color as string | undefined) ?? '',
      mark: (e.getAttributes('highlight').color as string | undefined) ?? (e.isActive('highlight') ? 'on' : ''),
      left: e.isActive({ textAlign: 'left' }),
      center: e.isActive({ textAlign: 'center' }),
      right: e.isActive({ textAlign: 'right' }),
      details: e.isActive('details'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      quote: e.isActive('blockquote'),
      code: e.isActive('codeBlock'),
      inlineCode: e.isActive('code'),
      callout: e.isActive('callout'),
      table: e.isActive('table'),
      link: e.isActive('link'),
    }),
  })
  const run = (fn: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => fn(editor.chain().focus()).run()
  const btn = (label: string, icon: React.ReactNode, active: boolean, fn: () => void, disabled = false) => (
    <button
      type="button"
      className={`fnotes__btn${active ? ' is-on' : ''}`}
      aria-label={label}
      aria-pressed={active}
      data-tip={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={fn}
      disabled={disabled}
    >
      {icon}
    </button>
  )
  // quote, code, callout, toggle, divider, table
  const blocks = (
    <>
      {btn('Quote', <LuQuote />, on.quote, () => run((c) => c.toggleBlockquote()))}
      {btn('Code block', <LuCode />, on.code, () => run((c) => c.toggleCodeBlock()))}
      {btn('Callout', <LuLightbulb />, on.callout, () => run((c) => c.toggleWrap('callout')))}
      {btn('Collapsible section', <LuChevronsDownUp />, on.details, () => run((c) => (on.details ? c.unsetDetails() : c.setDetails())))}
      {btn('Divider', <LuMinus />, false, () => run((c) => c.setHorizontalRule()))}
      {btn('Table', <LuTable />, on.table, () => run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true })), on.table)}
      {btn('Drawing', <LuPenTool />, false, () => insertDrawing(editor))}
    </>
  )
  // the block's kind (normal text, heading 1–6) and the selection's font size
  const blockPick = (
    <Select
      size="sm"
      className="fnotes__blocksel"
      ariaLabel="Text style"
      value={on.block}
      options={BLOCKS}
      optionLabel={(o) => <span className={`fnotes__blockopt fnotes__blockopt--${o.value || 'p'}`}>{o.label}</span>}
      display={(o) => (o.value ? `Heading ${o.value}` : 'Normal')}
      menuWidth={170}
      onChange={(v) => run((c) => (v ? c.setHeading({ level: Number(v) as 1 | 2 | 3 | 4 | 5 | 6 }) : c.setParagraph()))}
    />
  )
  const sizePick = <FontSizePick value={on.size} onPick={(v) => run((c) => (v ? c.setFontSize(v) : c.unsetFontSize()))} />
  // the toolbar's groups, in order: what doesn't fit the width goes behind "⋯" at the end
  const groups = [
    <>
      {blockPick}
      {sizePick}
    </>,
    <>
      {btn('Bold', <LuBold />, on.bold, () => run((c) => c.toggleBold()))}
      {btn('Italic', <LuItalic />, on.italic, () => run((c) => c.toggleItalic()))}
      {btn('Underline', <LuUnderline />, on.underline, () => run((c) => c.toggleUnderline()))}
      {btn('Strikethrough', <LuStrikethrough />, on.strike, () => run((c) => c.toggleStrike()))}
      {btn('Inline code', <LuCodeXml />, on.inlineCode, () => run((c) => c.toggleCode()))}
      <Swatches label="Text colour" icon={<LuBaseline />} value={on.color} onPick={(color) => run((c) => (color ? c.setColor(color) : c.unsetColor()))} />
      <Swatches
        label="Highlight"
        icon={<LuHighlighter />}
        value={on.mark === 'on' ? '' : on.mark}
        marker
        onPick={(color) => run((c) => (color ? c.setHighlight({ color }) : c.unsetHighlight()))}
      />
    </>,
    <>
      {btn('Heading 1', <LuHeading1 />, on.h1, () => run((c) => c.toggleHeading({ level: 1 })))}
      {btn('Heading 2', <LuHeading2 />, on.h2, () => run((c) => c.toggleHeading({ level: 2 })))}
      {btn('Heading 3', <LuHeading3 />, on.h3, () => run((c) => c.toggleHeading({ level: 3 })))}
    </>,
    <>
      {btn('Align left', <LuAlignLeft />, on.left, () => run((c) => c.setTextAlign('left')))}
      {btn('Align centre', <LuAlignCenter />, on.center, () => run((c) => c.setTextAlign('center')))}
      {btn('Align right', <LuAlignRight />, on.right, () => run((c) => c.setTextAlign('right')))}
    </>,
    <>
      {btn('Bulleted list', <LuList />, on.bullet, () => run((c) => c.toggleBulletList()))}
      {btn('Numbered list', <LuListOrdered />, on.ordered, () => run((c) => c.toggleOrderedList()))}
      {btn('Checkbox list', <LuSquareCheck />, on.task, () => run((c) => c.toggleTaskList()))}
    </>,
    blocks,
    <>
      {btn('Link (Ctrl/Cmd+K)', <LuLink />, on.link, onLink)}
      {btn('Insert image', <LuImagePlus />, false, onPickImage)}
    </>,
  ]
  const done = () => (editor.commands.blur(), onDone())
  if (phone) {
    // phones: the tools used most in a row that scrolls; the rest behind ⋯ (the same groups, minus those)
    const main = (
      <>
        {btn('Bold', <LuBold />, on.bold, () => run((c) => c.toggleBold()))}
        {btn('Italic', <LuItalic />, on.italic, () => run((c) => c.toggleItalic()))}
        {btn('Bulleted list', <LuList />, on.bullet, () => run((c) => c.toggleBulletList()))}
        {btn('Numbered list', <LuListOrdered />, on.ordered, () => run((c) => c.toggleOrderedList()))}
        {btn('Checkbox list', <LuSquareCheck />, on.task, () => run((c) => c.toggleTaskList()))}
        {btn('Insert image', <LuImagePlus />, false, onPickImage)}
        {blockPick}
      </>
    )
    const rest = [
      sizePick,
      <>
        {btn('Underline', <LuUnderline />, on.underline, () => run((c) => c.toggleUnderline()))}
        {btn('Strikethrough', <LuStrikethrough />, on.strike, () => run((c) => c.toggleStrike()))}
        {btn('Inline code', <LuCodeXml />, on.inlineCode, () => run((c) => c.toggleCode()))}
        {btn('Link', <LuLink />, on.link, onLink)}
        <Swatches label="Text colour" icon={<LuBaseline />} value={on.color} onPick={(color) => run((c) => (color ? c.setColor(color) : c.unsetColor()))} />
        <Swatches label="Highlight" icon={<LuHighlighter />} value={on.mark === 'on' ? '' : on.mark} marker onPick={(color) => run((c) => (color ? c.setHighlight({ color }) : c.unsetHighlight()))} />
      </>,
      groups[3],
      blocks,
    ]
    return <PhoneToolbar main={main} rest={rest} onDone={done} />
  }
  return (
    <FittingToolbar
      groups={groups}
      onDone={done}
      trail={btn(full ? 'Exit full size (Esc)' : 'Full size', full ? <LuMinimize2 /> : <LuMaximize2 />, full, onFull)}
    />
  )
}

/** Undo / redo, outside the formatting toolbar. */
function History({ editor }: { editor: Editor }) {
  const can = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      undo: e.can().undo(),
      redo: e.can().redo(),
    }),
  })
  const btn = (label: string, icon: React.ReactNode, fn: () => void, disabled: boolean) => (
    <button type="button" className="fnotes__btn" aria-label={label} data-tip={label} onMouseDown={(e) => e.preventDefault()} onClick={fn} disabled={disabled}>
      {icon}
    </button>
  )
  return (
    <span className="fnotes__history">
      {btn('Undo', <LuUndo2 />, () => editor.chain().focus().undo().run(), !can.undo)}
      {btn('Redo', <LuRedo2 />, () => editor.chain().focus().redo().run(), !can.redo)}
    </span>
  )
}

/**
 * Phones: writing takes the whole screen (the window steps aside, projects.css), and that's a step of its own in the
 * history (?nwrite=1): the Back gesture ends the writing and goes back to the note, instead of closing the note's
 * window. ✓, or leaving the editor some other way, takes the step back out.
 */
function useWritingStep(onEnd: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  const step = useParam('nwrite')
  const phone = () => window.matchMedia('(max-width: 768px)').matches
  // Back while writing: the step is gone, the editor lets go
  useEffect(() => {
    const el = ref.current
    const focused = document.activeElement as HTMLElement | null
    if (!step && el && focused && el.contains(focused)) focused.blur()
  }, [step])
  const onFocus = () => {
    if (phone() && !getParam('nwrite')) openUrl({ nwrite: 1 })
  }
  const onBlur = () => {
    // focus moving within (a toolbar menu): still writing
    setTimeout(() => {
      if (ref.current?.contains(document.activeElement)) return
      if (getParam('nwrite')) setUrl({ nwrite: null })
      if (phone()) onEnd()
    }, 0)
  }
  return { ref, onFocus, onBlur }
}

/**
 * One row, never wrapped: the groups that fit the width are shown, the rest open from "⋯" at the end (a narrow
 * window or a phone). Widths are measured as they're shown, and kept for when they're tucked away.
 */
function FittingToolbar({ groups, onDone, trail }: { groups: React.ReactNode[]; onDone: () => void; trail?: React.ReactNode }) {
  const bar = useRef<HTMLDivElement>(null)
  const widths = useRef<number[]>([])
  const [fit, setFit] = useState(groups.length)
  const [open, setOpen] = useState(false)
  const more = useRef<HTMLSpanElement>(null)
  const done = useRef<HTMLButtonElement>(null)
  // always shown at the right end, before "⋯" (Full size)
  const end = useRef<HTMLSpanElement>(null)

  const measure = useRef(() => {})
  measure.current = () => {
    const el = bar.current
    // not on screen (a minimized window, a hidden section): measured when it shows
    if (!el?.clientWidth) return
    el.querySelectorAll<HTMLElement>(':scope > .fnotes__group').forEach((g, i) => {
      if (g.offsetWidth) widths.current[i] = g.offsetWidth
    })
    // a group never measured yet: show them all once, to measure
    if (widths.current.filter(Boolean).length < groups.length) return setFit(groups.length)
    // ✓ (phones, while writing) takes its room first
    // the row's own padding and the gaps between its items count too (else the last group wraps under the rest)
    const css = getComputedStyle(el)
    const gap = parseFloat(css.columnGap) || 0
    const pad = (parseFloat(css.paddingLeft) || 0) + (parseFloat(css.paddingRight) || 0)
    const room = el.clientWidth - pad - 8 - (done.current?.offsetWidth ? done.current.offsetWidth + 2 + gap : 0) - (end.current?.offsetWidth ? end.current.offsetWidth + gap : 0)
    let n = 0
    let used = 0
    for (; n < groups.length; n++) {
      // the last ones only fit if "⋯" isn't needed after them
      const rest = n < groups.length - 1 ? MORE_WIDTH + gap : 0
      if (used + widths.current[n] + gap + rest > room) break
      used += widths.current[n] + gap
    }
    setFit(n)
  }
  useLayoutEffect(() => {
    const el = bar.current
    if (!el) return
    const ro = new ResizeObserver(() => measure.current())
    ro.observe(el)
    if (done.current) ro.observe(done.current)
    return () => ro.disconnect()
  }, [])
  // after showing more or fewer: measured again (settles at once)
  useLayoutEffect(() => measure.current(), [fit])

  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      const t = e.target as HTMLElement
      // a colour palette or a select's list opened from the menu sits on <body>: part of it
      if (!more.current?.contains(t) && !t.closest?.('.fnotes__palette, .rs__menu')) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  useEffect(() => {
    if (fit >= groups.length) setOpen(false)
  }, [fit, groups.length])

  return (
    <div className="fnotes__tools" role="toolbar" aria-label="Formatting" ref={bar}>
      {groups.map((g, i) => (
        <span key={i} className="fnotes__group" hidden={i >= fit}>
          {g}
        </span>
      ))}
      {trail && (
        <span className="fnotes__trail" ref={end}>
          {trail}
        </span>
      )}
      {fit < groups.length && (
        <span className="fnotes__more" ref={more}>
          <button
            type="button"
            className={`fnotes__btn${open ? ' is-on' : ''}`}
            aria-label="More formatting"
            aria-expanded={open}
            data-tip="More"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOpen((v) => !v)}
          >
            <LuEllipsis />
          </button>
          {open && (
            <span className="fnotes__menu ui-pop" role="group" aria-label="More formatting">
              {groups.slice(fit).map((g, i) => (
                <span key={i} className="fnotes__group">
                  {g}
                </span>
              ))}
            </span>
          )}
        </span>
      )}
      {/* phones, while writing (the editor takes the whole screen): put the keyboard away and go back */}
      <button
        type="button"
        ref={done}
        className="fnotes__btn fnotes__done"
        aria-label="Done"
        data-tip="Done"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (onDone(), (document.activeElement as HTMLElement | null)?.blur())}
      >
        <LuCheck />
      </button>
    </div>
  )
}
/**
 * Phones: the most used tools in one row that scrolls sideways (faded at an edge with more beyond it), then ⋯ for the
 * rest and Done, both kept in view at the right end.
 */
function PhoneToolbar({ main, rest, onDone }: { main: React.ReactNode; rest: React.ReactNode[]; onDone: () => void }) {
  const row = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const [open, setOpen] = useState(false)
  const more = useRef<HTMLSpanElement>(null)
  const measure = () => {
    const el = row.current
    if (!el) return
    const left = el.scrollLeft > 2
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }))
  }
  useLayoutEffect(() => {
    measure()
    const ro = new ResizeObserver(measure)
    if (row.current) ro.observe(row.current)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      const t = e.target as HTMLElement
      if (!more.current?.contains(t) && !t.closest?.('.fnotes__palette, .rs__menu')) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  return (
    <div className="fnotes__tools fnotes__tools--phone" role="toolbar" aria-label="Formatting">
      <div ref={row} className={`fnotes__row${edges.left ? ' fade-left' : ''}${edges.right ? ' fade-right' : ''}`} onScroll={measure}>
        {main}
      </div>
      <span className="fnotes__more" ref={more}>
        <button type="button" className={`fnotes__btn${open ? ' is-on' : ''}`} aria-label="More formatting" aria-expanded={open} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((v) => !v)}>
          <LuEllipsis />
        </button>
        {open && (
          <span className="fnotes__menu ui-pop" role="group" aria-label="More formatting">
            {rest.map((g, i) => (
              <span key={i} className="fnotes__group">
                {g}
              </span>
            ))}
          </span>
        )}
      </span>
      {/* phones: just its ✓ (round), the room goes to the tools */}
      <button
        type="button"
        className="small primary fnotes__done-pill"
        aria-label="Done"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (onDone(), (document.activeElement as HTMLElement | null)?.blur())}
      >
        <LuCheck />
      </button>
    </div>
  )
}

/** Room kept for "⋯" (its button and the gap before it). */
const MORE_WIDTH = 40

/** The block kinds of the toolbar's Text style ('' normal text, else the heading's level). */
const BLOCKS: { value: '' | '1' | '2' | '3' | '4' | '5' | '6'; label: string }[] = [
  { value: '', label: 'Normal text' },
  ...([1, 2, 3, 4, 5, 6] as const).map((n) => ({ value: String(n) as '1', label: `Heading ${n}` })),
]
const blockOf = (e: Editor) => BLOCKS.find((b) => b.value && e.isActive('heading', { level: Number(b.value) }))?.value ?? ''

/** The font sizes offered (px); any other from 8 to 96 can be typed. */
const SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48]
const SIZE_MIN = 8
const SIZE_MAX = 96
/** A size typed in ("20", "20px"), when it's one a note may have. */
const typedSize = (v: string) => {
  const m = v.trim().match(/^(\d{1,3}(?:\.\d)?)\s*(px)?$/i)
  const n = m ? Math.round(Number(m[1])) : NaN
  return n >= SIZE_MIN && n <= SIZE_MAX ? n : null
}
/** The selection's font size: '' (default), '20px', or 'mixed' (more than one in it). */
function sizeOf(e: Editor) {
  const { from, to, empty } = e.state.selection
  if (empty) return (e.getAttributes('textStyle').fontSize as string | undefined) ?? ''
  const seen = new Set<string>()
  e.state.doc.nodesBetween(from, to, (n) => {
    if (n.isText) seen.add((n.marks.find((m) => m.type.name === 'textStyle')?.attrs.fontSize as string | undefined) ?? '')
  })
  return seen.size > 1 ? 'mixed' : ([...seen][0] ?? '')
}

type SizeOption = { value: string; label: string }
/** The font size: Default, a size from the list, or one typed in (8–96 px); a selection with several shows Mixed. */
function FontSizePick({ value, onPick }: { value: string; onPick: (size: string) => void }) {
  const options: SizeOption[] = [{ value: '', label: 'Default' }, ...SIZES.map((n) => ({ value: `${n}px`, label: String(n) }))]
  const own = value && value !== 'mixed' && !options.some((o) => o.value === value)
  // a size typed in before (or pasted in): shown as it is
  if (own) options.push({ value, label: value.replace(/px$/, '') })
  const current = value === 'mixed' ? { value: 'mixed', label: 'Mixed' } : (options.find((o) => o.value === value) ?? options[0])
  return (
    <CreatableSelect<SizeOption, false>
      unstyled
      aria-label="Font size"
      className="rs rs--sm fnotes__sizesel"
      classNamePrefix="rs"
      value={current}
      options={options}
      onChange={(o) => o && onPick(o.value)}
      onCreateOption={(v) => {
        const n = typedSize(v)
        if (n) onPick(`${n}px`)
      }}
      isValidNewOption={(v) => typedSize(v) !== null && !options.some((o) => o.value === `${typedSize(v)}px`)}
      formatCreateLabel={(v) => `Use ${typedSize(v)} px`}
      noOptionsMessage={({ inputValue }) => (inputValue ? `${SIZE_MIN}–${SIZE_MAX} px` : 'No sizes')}
      placeholder="Size"
      // the list keeps its order (a typed "1" doesn't hide the others behind a filter of labels only)
      filterOption={(o, input) => !input || '__isNew__' in o.data || o.label.startsWith(input.trim().replace(/\s*px$/i, ''))}
      menuPortalTarget={document.body}
      menuPlacement="auto"
      styles={{ menuPortal: (base) => ({ ...base, width: 120 }) }}
      classNames={{
        control: (st) => (st.isFocused ? 'rs__control--focused' : ''),
        option: (st) => [st.isSelected && 'rs__option--selected', st.isFocused && 'rs__option--focused'].filter(Boolean).join(' '),
      }}
      // the list's sizes with their unit (not "Default", nor the "Use 22 px" of one typed in)
      formatOptionLabel={(o, meta) =>
        meta.context === 'menu' && /^\d+$/.test(o.label) ? (
          <>
            {o.label}
            <span className="fnotes__px"> px</span>
          </>
        ) : (
          o.label
        )
      }
    />
  )
}

const TEXT_COLORS = ['#e5484d', '#f07a1d', '#d4a017', '#2f8f57', '#0ea5a4', '#3b82f6', '#a855f7', '#e0558f', '#8b8d98']
const MARKERS = ['#fde68a', '#fed7aa', '#fecaca', '#bbf7d0', '#bae6fd', '#ddd6fe', '#fbcfe8', '#e5e7eb']

/** A colour button with its palette (text colour, or a highlighter's); the first swatch clears it. */
function Swatches({
  label,
  icon,
  value,
  onPick,
  marker,
}: {
  label: string
  icon: React.ReactNode
  value: string
  onPick: (color: string) => void
  marker?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const palette = useRef<HTMLSpanElement>(null)
  // the palette is drawn over the page (the toolbar scrolls sideways on phones and would cut it off), under its button
  const [at, setAt] = useState({ top: 0, left: 0 })
  useLayoutEffect(() => {
    if (!open || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    setAt({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 168)) })
  }, [open])
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && !palette.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  const colors = marker ? MARKERS : TEXT_COLORS
  return (
    <span className="fnotes__swatch-wrap" ref={ref}>
      <button
        type="button"
        className={`fnotes__btn${value ? ' has-color' : ''}`}
        style={{ ['--swatch' as string]: value || 'transparent' }}
        aria-label={label}
        aria-expanded={open}
        data-tip={label}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        {icon}
      </button>
      {open &&
        createPortal(
          <span ref={palette} className="fnotes__palette" style={at} role="menu" aria-label={label}>
            <button
              type="button"
              className="fnotes__chip fnotes__chip--none"
              aria-label="None"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (onPick(''), setOpen(false))}
            />
            {colors.map((c) => (
              <button
                key={c}
                type="button"
                className={`fnotes__chip${value === c ? ' is-on' : ''}`}
                style={{ background: c }}
                aria-label={c}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => (onPick(c), setOpen(false))}
              />
            ))}
          </span>,
          document.body,
        )}
    </span>
  )
}
