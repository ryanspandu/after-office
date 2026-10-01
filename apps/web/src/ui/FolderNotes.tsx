import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { dateTime } from './when'
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
import {
  LuAlignCenter,
  LuAlignLeft,
  LuAlignRight,
  LuBaseline,
  LuBold,
  LuCheck,
  LuChevronsDownUp,
  LuHeading3,
  LuGripVertical,
  LuHighlighter,
  LuMinus,
  LuSquareCheck,
  LuCode,
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
import { api } from '../state/auth'

// The owner's own notes on a folder (the folder details' Notes): a rich text editor (TipTap), kept as HTML in the
// dashboard's database, never written into the folder (so no agent reads them, and nothing ends up in its git). Saved
// as you type. Loaded only when Notes is opened.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** Notes written before the editor (plain text): one paragraph per line. */
const asHtml = (text: string) =>
  !text.trim() || text.trimStart().startsWith('<')
    ? text
    : text
        .split('\n')
        .map((l) => `<p>${esc(l)}</p>`)
        .join('')

export default function FolderNotes({ path }: { path: string }) {
  const [loaded, setLoaded] = useState<{
    html: string
    at: number | null
  } | null>(null)
  useEffect(() => {
    void api(`/api/workspaces/notes?${new URLSearchParams({ path })}`)
      .then((r) => (r.ok ? r.json() : { text: '', updatedAt: null }))
      .then((r: { text: string; updatedAt: number | null }) => setLoaded({ html: asHtml(r.text), at: r.updatedAt }))
      .catch(() => setLoaded({ html: '', at: null }))
  }, [path])
  if (loaded === null)
    return (
      <div className="fd__panel muted">
        <LuLoader className="spin" />
      </div>
    )
  return <NotesEditor key={path} path={path} initial={loaded.html} initialAt={loaded.at} />
}

function NotesEditor({ path, initial, initialAt }: { path: string; initial: string; initialAt: number | null }) {
  const [state, setState] = useState<'saved' | 'saving' | 'error'>('saved')
  // when they were last saved (none yet: nothing written)
  const [savedAt, setSavedAt] = useState(initialAt)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<string | null>(null)

  const save = async (html: string) => {
    setState('saving')
    try {
      const r = await api('/api/workspaces/notes', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, text: html }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Could not save')
      setSavedAt(
        (
          (await r.json().catch(() => null)) as {
            updatedAt?: number | null
          } | null
        )?.updatedAt ?? null,
      )
      setError(null)
      if (pending.current === html) pending.current = null
      setState(pending.current ? 'saving' : 'saved')
    } catch (e) {
      setError((e as Error).message)
      setState('error')
    }
  }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      }),
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
      Placeholder.configure({
        placeholder: 'Your notes on this folder: ideas, todos, links… Kept in the dashboard, not in the folder, so the agents don’t read them.',
      }),
    ],
    content: initial,
    autofocus: initial.trim() ? false : 'end',
    onUpdate: ({ editor: e }) => {
      // an empty editor is "<p></p>": nothing
      const html = e.isEmpty ? '' : e.getHTML()
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

  return (
    <div className="fnotes">
      <div className="fnotes__meta">
        {editor && <History editor={editor} />}
        <span className="grow" />
        <span className={`fnotes__state muted${state === 'error' ? ' danger-text' : ''}`}>
          {state === 'saving' ? (
            <>
              <LuLoader className="spin" /> Saving…
            </>
          ) : state === 'error' ? (
            error
          ) : (
            <>
              <LuCheck /> Saved
              {savedAt !== null && <span className="fnotes__at">· {dateTime(savedAt)}</span>}
            </>
          )}
        </span>
        {/* phones, while typing (the editor takes the whole screen): put the keyboard away and go back */}
        <button
          type="button"
          className="small fnotes__done"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => (editor?.commands.blur(), (document.activeElement as HTMLElement | null)?.blur())}
        >
          Done
        </button>
      </div>
      {/* the toolbar sits right on top of the text box, as one piece */}
      <div className="fnotes__box">
        <div className="fnotes__bar">{editor && <Toolbar editor={editor} />}</div>
        <div className="fnotes__editor">
          {/* like Notion: a grip beside the block under the pointer drags it (a paragraph, a list item, a section…) */}
          {editor && (
            <DragHandle editor={editor}>
              <div className="fnotes__grip" aria-label="Drag to move">
                <LuGripVertical />
              </div>
            </DragHandle>
          )}
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  )
}

function Toolbar({ editor }: { editor: Editor }) {
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
      size: (e.getAttributes('textStyle').fontSize as string | undefined) ?? '',
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
      link: e.isActive('link'),
    }),
  })
  const run = (fn: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => fn(editor.chain().focus()).run()
  const link = () => {
    const prev = editor.getAttributes('link').href as string | undefined
    const url = window.prompt('Link address (empty removes it)', prev ?? 'https://')
    if (url === null) return
    if (!url.trim()) return run((c) => c.extendMarkRange('link').unsetLink())
    run((c) => c.extendMarkRange('link').setLink({ href: url.trim() }))
  }
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
  return (
    <div className="fnotes__tools" role="toolbar" aria-label="Formatting">
      <span className="fnotes__group">
        <select
          className="fnotes__size"
          aria-label="Font size"
          data-tip="Font size"
          value={on.size}
          onChange={(e) => run((c) => (e.target.value ? c.setFontSize(e.target.value) : c.unsetFontSize()))}
        >
          {SIZES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </span>
      <span className="fnotes__group">
        {btn('Bold', <LuBold />, on.bold, () => run((c) => c.toggleBold()))}
        {btn('Italic', <LuItalic />, on.italic, () => run((c) => c.toggleItalic()))}
        {btn('Underline', <LuUnderline />, on.underline, () => run((c) => c.toggleUnderline()))}
        {btn('Strikethrough', <LuStrikethrough />, on.strike, () => run((c) => c.toggleStrike()))}
        <Swatches label="Text colour" icon={<LuBaseline />} value={on.color} onPick={(color) => run((c) => (color ? c.setColor(color) : c.unsetColor()))} />
        <Swatches
          label="Highlight"
          icon={<LuHighlighter />}
          value={on.mark === 'on' ? '' : on.mark}
          marker
          onPick={(color) => run((c) => (color ? c.setHighlight({ color }) : c.unsetHighlight()))}
        />
      </span>
      <span className="fnotes__group">
        {btn('Heading', <LuHeading1 />, on.h1, () => run((c) => c.toggleHeading({ level: 1 })))}
        {btn('Subheading', <LuHeading2 />, on.h2, () => run((c) => c.toggleHeading({ level: 2 })))}
        {btn('Small heading', <LuHeading3 />, on.h3, () => run((c) => c.toggleHeading({ level: 3 })))}
      </span>
      <span className="fnotes__group">
        {btn('Align left', <LuAlignLeft />, on.left, () => run((c) => c.setTextAlign('left')))}
        {btn('Align centre', <LuAlignCenter />, on.center, () => run((c) => c.setTextAlign('center')))}
        {btn('Align right', <LuAlignRight />, on.right, () => run((c) => c.setTextAlign('right')))}
      </span>
      <span className="fnotes__group">
        {btn('Bulleted list', <LuList />, on.bullet, () => run((c) => c.toggleBulletList()))}
        {btn('Numbered list', <LuListOrdered />, on.ordered, () => run((c) => c.toggleOrderedList()))}
        {btn('Checkbox list', <LuSquareCheck />, on.task, () => run((c) => c.toggleTaskList()))}
      </span>
      <span className="fnotes__group">
        {btn('Quote', <LuQuote />, on.quote, () => run((c) => c.toggleBlockquote()))}
        {btn('Code block', <LuCode />, on.code, () => run((c) => c.toggleCodeBlock()))}
        {btn('Collapsible section', <LuChevronsDownUp />, on.details, () => run((c) => (on.details ? c.unsetDetails() : c.setDetails())))}
        {btn('Divider', <LuMinus />, false, () => run((c) => c.setHorizontalRule()))}
        {btn('Link', <LuLink />, on.link, link)}
      </span>
    </div>
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

const SIZES = [
  { value: '', label: 'Normal' },
  { value: '12px', label: 'Small' },
  { value: '18px', label: 'Large' },
  { value: '24px', label: 'Huge' },
  { value: '32px', label: 'Title' },
]

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
