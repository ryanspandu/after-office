import { Extension, Node, mergeAttributes } from '@tiptap/react'
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight'
import { Table, TableView } from '@tiptap/extension-table'
import { columnResizing } from '@tiptap/pm/tables'
import { common, createLowlight } from 'lowlight'
import { CALLOUT_EMOJIS } from '@after-office/shared'

// The notes' own blocks beside StarterKit's (ui/FolderNotes.tsx): a callout, code blocks with their language and
// colours, tables with columns that can be resized, and Cmd/Ctrl+K for a link. Each one reads back as Markdown
// (packages/shared/src/noteText.ts).

// ── callout: an icon and some text on a tinted box (<div data-type="callout" data-emoji="💡">) ──

const knownEmoji = (v: string | null | undefined) => (v && CALLOUT_EMOJIS.includes(v) ? v : CALLOUT_EMOJIS[0])

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      emoji: {
        default: CALLOUT_EMOJIS[0],
        parseHTML: (el: HTMLElement) => knownEmoji(el.getAttribute('data-emoji')),
        renderHTML: (a: { emoji?: string }) => ({ 'data-emoji': knownEmoji(a.emoji) }),
      },
    }
  },
  parseHTML: () => [{ tag: 'div[data-type="callout"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes({ 'data-type': 'callout' }, HTMLAttributes), 0],
  // its icon: a button (while writing, a click turns it into the next one); the text beside it
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node
      const dom = document.createElement('div')
      dom.className = 'callout'
      dom.dataset.type = 'callout'
      const icon = document.createElement('button')
      icon.type = 'button'
      icon.className = 'callout__icon'
      icon.contentEditable = 'false'
      icon.textContent = knownEmoji(node.attrs.emoji)
      icon.setAttribute('aria-label', 'Change the icon')
      icon.addEventListener('mousedown', (e) => e.preventDefault())
      icon.addEventListener('click', () => {
        const pos = getPos()
        if (!editor.isEditable || typeof pos !== 'number') return
        const next = CALLOUT_EMOJIS[(CALLOUT_EMOJIS.indexOf(knownEmoji(current.attrs.emoji)) + 1) % CALLOUT_EMOJIS.length]
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, emoji: next }))
      })
      const body = document.createElement('div')
      body.className = 'callout__body'
      dom.append(icon, body)
      return {
        dom,
        contentDOM: body,
        update: (n) => {
          if (n.type !== current.type) return false
          current = n
          icon.textContent = knownEmoji(n.attrs.emoji)
          return true
        },
        stopEvent: (e) => icon.contains(e.target as globalThis.Node),
        ignoreMutation: (m) => icon.contains(m.target),
      }
    }
  },
})

// ── code blocks: coloured by lowlight (its common languages), the language picked in the block's corner ──

const lowlight = createLowlight(common)

/** The languages offered in a code block's corner ('' guesses from the code). */
const LANGUAGES: [string, string][] = [
  ['', 'Auto'],
  ['plaintext', 'Plain text'],
  ['bash', 'Bash'],
  ['c', 'C'],
  ['cpp', 'C++'],
  ['csharp', 'C#'],
  ['css', 'CSS'],
  ['diff', 'Diff'],
  ['go', 'Go'],
  ['xml', 'HTML / XML'],
  ['java', 'Java'],
  ['javascript', 'JavaScript'],
  ['json', 'JSON'],
  ['kotlin', 'Kotlin'],
  ['markdown', 'Markdown'],
  ['php', 'PHP'],
  ['python', 'Python'],
  ['ruby', 'Ruby'],
  ['rust', 'Rust'],
  ['scss', 'SCSS'],
  ['sql', 'SQL'],
  ['swift', 'Swift'],
  ['typescript', 'TypeScript'],
  ['yaml', 'YAML'],
]

export const NoteCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node
      const dom = document.createElement('div')
      dom.className = 'code-block'
      const corner = document.createElement('span')
      corner.className = 'code-block__lang'
      corner.contentEditable = 'false'
      const pick = document.createElement('select')
      pick.setAttribute('aria-label', 'Code language')
      for (const [value, label] of LANGUAGES) pick.append(new Option(label, value))
      const show = (lang: string | null) => {
        // one typed after ``` that isn't in the list: offered as it is
        if (lang && ![...pick.options].some((o) => o.value === lang)) pick.append(new Option(lang, lang))
        pick.value = lang ?? ''
      }
      show(node.attrs.language)
      pick.addEventListener('change', () => {
        const pos = getPos()
        if (!editor.isEditable || typeof pos !== 'number') return show(current.attrs.language)
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, language: pick.value || null }))
      })
      corner.append(pick)
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      pre.append(code)
      dom.append(corner, pre)
      return {
        dom,
        contentDOM: code,
        update: (n) => {
          if (n.type !== current.type) return false
          current = n
          show(n.attrs.language)
          return true
        },
        stopEvent: (e) => corner.contains(e.target as globalThis.Node),
        ignoreMutation: (m) => corner.contains(m.target),
      }
    }
  },
}).configure({ lowlight, defaultLanguage: null, enableTabIndentation: true })

// ── tables: columns resized by dragging their edge, also in a note that opened to read first (Edit) ──

export const NoteTable = Table.extend({
  // TipTap only adds the column resizing to an editor that's editable when it's made; prosemirror-tables itself only
  // lets them be dragged while it is
  addProseMirrorPlugins() {
    const own = this.parent?.() ?? []
    if (this.editor.isEditable) return own
    const { cellMinWidth, handleWidth, lastColumnResizable } = this.options
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return [columnResizing({ handleWidth, cellMinWidth, defaultCellMinWidth: cellMinWidth, View: TableView as any, lastColumnResizable }), ...own]
  },
  // the resizing plugin draws it (in its scrolling wrapper)
  addNodeView: () => null,
}).configure({ resizable: true })

// ── Cmd/Ctrl+K: the link popover (FolderNotes.tsx LinkPop) ──

export const LinkKey = Extension.create<{ open: () => void }>({
  name: 'linkKey',
  addOptions: () => ({ open: () => {} }),
  addKeyboardShortcuts() {
    return {
      'Mod-k': () => {
        if (!this.editor.isEditable) return false
        this.options.open()
        return true
      },
    }
  },
})
