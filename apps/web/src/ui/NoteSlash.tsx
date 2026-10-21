import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Extension, type Editor, type Range } from '@tiptap/react'
import { Suggestion, type SuggestionProps } from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'
import { insertDrawing } from './NoteDrawing'
import {
  LuCalendar,
  LuChevronsDownUp,
  LuCode,
  LuHeading1,
  LuHeading2,
  LuHeading3,
  LuHeading4,
  LuHeading5,
  LuHeading6,
  LuImagePlus,
  LuLightbulb,
  LuList,
  LuListOrdered,
  LuMinus,
  LuPenTool,
  LuPilcrow,
  LuQuote,
  LuSquareCheck,
  LuTable,
} from 'react-icons/lu'

// The "/" menu of the notes' editor (ui/FolderNotes.tsx), like Notion's: "/" at the start of a line or after a space
// opens it under the caret, typing filters it, ↑/↓ and Enter (or a click / tap) put the block in, Esc closes it.

export interface SlashItem {
  title: string
  hint: string
  icon: React.ReactNode
  /** more words it's found by */
  keys: string
  run: (editor: Editor, range: Range) => void
}

/** Today as "21 Oct 2026". */
const today = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

const ITEMS = (pickImage: () => void): SlashItem[] => {
  const at = (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range)
  return [
    { title: 'Text', hint: 'Plain writing', icon: <LuPilcrow />, keys: 'paragraph plain normal', run: (e, r) => at(e, r).setParagraph().run() },
    { title: 'Heading 1', hint: 'Big section title', icon: <LuHeading1 />, keys: 'h1 title', run: (e, r) => at(e, r).setHeading({ level: 1 }).run() },
    { title: 'Heading 2', hint: 'Medium section title', icon: <LuHeading2 />, keys: 'h2 subheading', run: (e, r) => at(e, r).setHeading({ level: 2 }).run() },
    { title: 'Heading 3', hint: 'Small section title', icon: <LuHeading3 />, keys: 'h3', run: (e, r) => at(e, r).setHeading({ level: 3 }).run() },
    { title: 'Heading 4', hint: 'A smaller title', icon: <LuHeading4 />, keys: 'h4', run: (e, r) => at(e, r).setHeading({ level: 4 }).run() },
    { title: 'Heading 5', hint: 'A small title', icon: <LuHeading5 />, keys: 'h5', run: (e, r) => at(e, r).setHeading({ level: 5 }).run() },
    { title: 'Heading 6', hint: 'The smallest title', icon: <LuHeading6 />, keys: 'h6', run: (e, r) => at(e, r).setHeading({ level: 6 }).run() },
    { title: 'Bulleted list', hint: 'A simple list', icon: <LuList />, keys: 'ul bullet unordered', run: (e, r) => at(e, r).toggleBulletList().run() },
    { title: 'Numbered list', hint: 'A list with numbers', icon: <LuListOrdered />, keys: 'ol ordered', run: (e, r) => at(e, r).toggleOrderedList().run() },
    { title: 'To-do list', hint: 'Things to tick off', icon: <LuSquareCheck />, keys: 'todo task checkbox checklist', run: (e, r) => at(e, r).toggleTaskList().run() },
    { title: 'Toggle', hint: 'A section that folds away', icon: <LuChevronsDownUp />, keys: 'details collapsible fold', run: (e, r) => at(e, r).setDetails().run() },
    { title: 'Quote', hint: 'Words from someone', icon: <LuQuote />, keys: 'blockquote citation', run: (e, r) => at(e, r).toggleBlockquote().run() },
    { title: 'Code block', hint: 'Code, coloured by language', icon: <LuCode />, keys: 'pre snippet', run: (e, r) => at(e, r).setCodeBlock().run() },
    { title: 'Callout', hint: 'Make a note stand out', icon: <LuLightbulb />, keys: 'info tip warning box', run: (e, r) => at(e, r).toggleWrap('callout').run() },
    { title: 'Divider', hint: 'A line between parts', icon: <LuMinus />, keys: 'hr rule separator line', run: (e, r) => at(e, r).setHorizontalRule().run() },
    { title: 'Table', hint: 'Rows and columns', icon: <LuTable />, keys: 'grid', run: (e, r) => at(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { title: 'Image', hint: 'Upload a picture', icon: <LuImagePlus />, keys: 'picture photo upload', run: (e, r) => (at(e, r).run(), pickImage()) },
    { title: 'Drawing', hint: 'Sketch by hand (pen, pencil, highlighter)', icon: <LuPenTool />, keys: 'sketch pen pencil draw', run: (e, r) => (at(e, r).run(), insertDrawing(e)) },
    { title: 'Date', hint: `Today, ${today()}`, icon: <LuCalendar />, keys: 'today now time', run: (e, r) => at(e, r).insertContent(`${today()} `).run() },
  ]
}

/** What the menu shows: between the editor's plugin and the React menu. */
export interface SlashState {
  items: SlashItem[]
  rect: () => DOMRect | null
  pick: (item: SlashItem) => void
}

/**
 * The open menu (or none), kept outside React so the editor's plugin can set it; the menu answers its keys. Everything
 * lives in this closure and is reached through functions: TipTap copies an extension's options (`configure`), so a
 * property set on the object later wouldn't reach the editor's copy.
 */
export function createSlashBridge() {
  let state: SlashState | null = null
  const subs = new Set<() => void>()
  let onKey: ((e: KeyboardEvent) => boolean) | null = null
  let pickImage = () => {}
  return {
    get: () => state,
    set: (s: SlashState | null) => {
      state = s
      subs.forEach((f) => f())
    },
    subscribe: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
    /** the menu's ↑ / ↓ / Enter (true: used) */
    key: (e: KeyboardEvent) => onKey?.(e) ?? false,
    setKey: (f: ((e: KeyboardEvent) => boolean) | null) => void (onKey = f),
    /** Image: the editor's picture picker */
    image: () => pickImage(),
    setImage: (f: () => void) => void (pickImage = f),
  }
}
export type SlashBridge = ReturnType<typeof createSlashBridge>

const find = (items: SlashItem[], query: string) => {
  const q = query.toLowerCase().trim()
  if (!q) return items
  const starts = items.filter((i) => i.title.toLowerCase().startsWith(q))
  const rest = items.filter((i) => !starts.includes(i) && `${i.title} ${i.keys}`.toLowerCase().includes(q))
  return [...starts, ...rest]
}

export const SlashCommand = Extension.create<{ bridge: SlashBridge }>({
  name: 'slashCommand',
  // before the editor's own keys: Enter / ↑ / ↓ go to the open menu, not a new line
  priority: 1000,
  addOptions: () => ({ bridge: createSlashBridge() }),
  addProseMirrorPlugins() {
    const bridge = this.options.bridge
    const show = (p: SuggestionProps<SlashItem, SlashItem>) => bridge.set({ items: p.items, rect: () => p.clientRect?.() ?? null, pick: (item) => p.command(item) })
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey('slashCommand'),
        char: '/',
        // at the start of a line, or after a space ("a/b" is just text)
        allowedPrefixes: [' '],
        // not in code (a path, a comment)
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query }) => find(ITEMS(() => bridge.image()), query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => ({
          onStart: show,
          onUpdate: show,
          onExit: () => bridge.set(null),
          onKeyDown: ({ event }) => {
            // Esc: the menu closes (the plugin does it), not the note's window
            if (event.key === 'Escape') return event.stopPropagation(), true
            return bridge.key(event)
          },
        }),
      }),
    ]
  },
})

/** The menu itself: under the caret (above it when there's no room below), inside the window. */
export function SlashMenu({ bridge }: { bridge: SlashBridge }) {
  const state = useSyncExternalStore(bridge.subscribe, bridge.get)
  const [active, setActive] = useState(0)
  const menu = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const items = state?.items ?? []

  // a new filter: back to the first
  useEffect(() => setActive(0), [items.length, items[0]?.title])
  useEffect(() => {
    if (!state) return
    bridge.setKey((e) => {
      if (!items.length) return false
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const d = e.key === 'ArrowDown' ? 1 : -1
        setActive((i) => (i + d + items.length) % items.length)
        return true
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        state.pick(items[Math.min(active, items.length - 1)])
        return true
      }
      return false
    })
    return () => bridge.setKey(null)
  }, [bridge, state, items, active])
  useLayoutEffect(() => {
    const r = state?.rect()
    const el = menu.current
    if (!r || !el) return setAt(null)
    const vh = window.visualViewport?.height ?? window.innerHeight
    const vw = window.innerWidth
    const h = el.offsetHeight
    const w = el.offsetWidth
    const below = r.bottom + 6
    const top = below + h > vh - 8 && r.top - 6 - h > 8 ? r.top - 6 - h : Math.max(8, Math.min(below, vh - h - 8))
    setAt({ top, left: Math.max(8, Math.min(r.left, vw - w - 8)) })
  }, [state, items.length])
  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('.is-active')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  if (!state) return null
  // in the note (not on <body>): a tap on it is still writing, on phones too (FolderNotes.tsx useWritingStep)
  return (
    <div
      ref={menu}
      className="slash-menu fb-menu"
      role="listbox"
      aria-label="Insert a block"
      style={at ?? { top: -9999, left: -9999 }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.length ? (
        items.map((item, i) => (
          <button
            key={item.title}
            type="button"
            role="option"
            aria-selected={i === active}
            className={i === active ? 'is-active' : ''}
            onMouseEnter={() => setActive(i)}
            onClick={() => state.pick(item)}
          >
            <span className="slash-menu__icon">{item.icon}</span>
            <span className="slash-menu__text">
              <span>{item.title}</span>
              <span className="slash-menu__hint">{item.hint}</span>
            </span>
          </button>
        ))
      ) : (
        <div className="slash-menu__none">No matching blocks</div>
      )}
    </div>
  )
}
