import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { LuCheck, LuPencilLine, LuReplace, LuTextCursorInput, LuUndo2 } from 'react-icons/lu'
import { tip } from './Tooltip'

// Text Marcus means for a note, in his reply (server: work/threads.ts noteHelperContext): a ```note block is a
// suggestion (Insert / Replace note, the owner's choice); a ```note-edit block is his edit, put in the note at once
// (once: remembered in this browser), with Undo. Only the note's helper chat (ui/NoteAssist.tsx) provides these
// actions; elsewhere such a block is plain code.

export interface NoteBlockActions {
  /** at the cursor (or the end of the note), the block's Markdown */
  insert: (markdown: string) => void
  /** the whole note becomes the block (after asking) */
  replace: (markdown: string) => Promise<boolean>
  /** his edit: the whole note becomes the block now, without asking; gives back an undo (null: not done) */
  apply: (markdown: string) => (() => void) | null
  /** whether this edit (by its text) was already put in, here or in an earlier visit */
  applied: (markdown: string) => boolean
  /** a reply that just came in (not the chat's history loading as it opens): only those go in by themselves */
  fresh: () => boolean
  /** a suggestion already put in (Insert or Replace), here or another time: its buttons are spent */
  used: (markdown: string) => 'insert' | 'replace' | null
  markUsed: (markdown: string, how: 'insert' | 'replace') => void
}

export const NoteBlockContext = createContext<NoteBlockActions | null>(null)

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}
const textOf = (n: HastNode): string => (n.type === 'text' ? (n.value ?? '') : (n.children ?? []).map(textOf).join(''))

/** A Markdown code block (FollowUps.tsx Markdown's `pre`): a ```note block gets Insert / Replace note in the helper. */
export function MdPre({ node, children }: { node?: unknown; children?: ReactNode }) {
  const actions = useContext(NoteBlockContext)
  const code = (node as HastNode | undefined)?.children?.find((c) => c.tagName === 'code')
  const classes = code?.properties?.className
  const lang = Array.isArray(classes) ? classes.find((c) => c === 'language-note' || c === 'language-note-edit') : undefined
  if (!actions || !code || !lang) return <pre className="md-code">{children}</pre>
  const markdown = textOf(code).replace(/\n$/, '')
  return lang === 'language-note-edit' ? <NoteEdit markdown={markdown} actions={actions} /> : <NoteBlock markdown={markdown} actions={actions} />
}

/** Marcus's edit: put in the note as soon as it shows (once), then a line saying so, with Undo while this is open. */
function NoteEdit({ markdown, actions }: { markdown: string; actions: NoteBlockActions }) {
  const [undo, setUndo] = useState<(() => void) | null>(null)
  // put in already (here, or another time); else: in now if it just came, or waiting for Apply (an old one)
  const [state, setState] = useState<'applied' | 'undone' | 'waiting'>(() => (actions.applied(markdown) || actions.fresh() ? 'applied' : 'waiting'))
  // what he wrote: already in the note (shown on asking); an old edit waiting for Apply shows it
  const [shown, setShown] = useState(false)
  const put = () => {
    const back = actions.apply(markdown)
    if (back) setUndo(() => back)
    setState('applied')
  }
  useEffect(() => {
    if (state === 'applied' && !actions.applied(markdown)) put()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className={`note-block note-block--edit${state === 'undone' ? ' is-undone' : ''}`}>
      <div className="note-block__edited">
        <LuPencilLine /> {state === 'undone' ? 'Edit undone' : state === 'waiting' ? 'An edit for the note' : 'Marcus edited the note'}
        <span className="grow" />
        {state === 'waiting' && (
          <button type="button" className="small primary" onClick={put} {...tip('Put this edit in the note (Undo after)')}>
            <LuCheck /> Apply
          </button>
        )}
        {state !== 'waiting' && markdown.trim() && (
          <button type="button" className="small ghost" aria-expanded={shown} onClick={() => setShown(!shown)}>
            {shown ? 'Hide' : 'View'}
          </button>
        )}
        {undo && state === 'applied' && (
          <button type="button" className="small ghost" onClick={() => (undo(), setState('undone'))} {...tip('Back to the note as it was before this edit')}>
            <LuUndo2 /> Undo
          </button>
        )}
      </div>
      {(state === 'waiting' || shown) && markdown.trim() && <div className="note-block__text">{markdown}</div>}
    </div>
  )
}

function NoteBlock({ markdown, actions }: { markdown: string; actions: NoteBlockActions }) {
  // used once (inserted or replaced): done, its buttons off (remembered, so the chat's history shows it too)
  const [done, setDone] = useState<'insert' | 'replace' | null>(() => actions.used(markdown))
  const use = (how: 'insert' | 'replace') => (actions.markUsed(markdown, how), setDone(how))
  return (
    <div className="note-block">
      <div className="note-block__text">{markdown}</div>
      <div className="note-block__actions">
        <button type="button" className="small primary" disabled={!!done} onClick={() => (actions.insert(markdown), use('insert'))} {...tip('Put it in the note at the cursor (or at its end)')}>
          {done === 'insert' ? <LuCheck /> : <LuTextCursorInput />} {done === 'insert' ? 'Inserted' : 'Insert'}
        </button>
        <button type="button" className="small ghost" disabled={!!done} onClick={() => void actions.replace(markdown).then((ok) => ok && use('replace'))} {...tip('The whole note becomes this text')}>
          {done === 'replace' ? <LuCheck /> : <LuReplace />} {done === 'replace' ? 'Replaced' : 'Replace note'}
        </button>
      </div>
    </div>
  )
}
