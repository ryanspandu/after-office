import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { LuCheck, LuReplace, LuTextCursorInput } from 'react-icons/lu'
import { tip } from './Tooltip'

// Text Marcus means for a note: a ```note block in his reply (server: work/threads.ts noteHelperContext). Only the note's
// helper chat (ui/NoteAssist.tsx) provides these actions; elsewhere such a block is plain code.

export interface NoteBlockActions {
  /** at the cursor (or the end of the note), the block's Markdown */
  insert: (markdown: string) => void
  /** the whole note becomes the block (after asking) */
  replace: (markdown: string) => Promise<boolean>
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
  const isNote = Array.isArray(classes) && classes.includes('language-note')
  if (!actions || !code || !isNote) return <pre className="md-code">{children}</pre>
  return <NoteBlock markdown={textOf(code).replace(/\n$/, '')} actions={actions} />
}

function NoteBlock({ markdown, actions }: { markdown: string; actions: NoteBlockActions }) {
  const [done, setDone] = useState<'insert' | 'replace' | null>(null)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(null), 2200)
    return () => clearTimeout(t)
  }, [done])
  return (
    <div className="note-block">
      <div className="note-block__text">{markdown}</div>
      <div className="note-block__actions">
        <button type="button" className="small primary" onClick={() => (actions.insert(markdown), setDone('insert'))} {...tip('Put it in the note at the cursor (or at its end)')}>
          {done === 'insert' ? <LuCheck /> : <LuTextCursorInput />} {done === 'insert' ? 'Inserted' : 'Insert'}
        </button>
        <button type="button" className="small ghost" onClick={() => void actions.replace(markdown).then((ok) => ok && setDone('replace'))} {...tip('The whole note becomes this text')}>
          {done === 'replace' ? <LuCheck /> : <LuReplace />} {done === 'replace' ? 'Replaced' : 'Replace note'}
        </button>
      </div>
    </div>
  )
}
