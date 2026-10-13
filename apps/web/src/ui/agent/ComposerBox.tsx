import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import { avatarStyle } from '../../state/store'

// The chat's message box. It holds what's typed itself, so a keystroke renders this textarea and nothing else (the
// chat above it, with every message and its Markdown, is left alone: on a phone that made typing heavy). Its text is
// kept in the browser as a draft until it's sent or emptied: closing the chat, a reload or the phone putting the app
// away doesn't lose it.

export interface ComposerHandle {
  get: () => string
  /** replace the text (a sent message empties it, a failed one comes back, a dictation lands in it) */
  set: (v: string) => void
  focus: (opts?: FocusOptions) => void
}

/** Someone the message can name with @ (a thread: the agents it can be handed to). */
export interface Mentionable {
  name: string
  role?: string
  color: string
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** "@Name" not followed by more of a word (so "@Kai" doesn't count in "@Kaiden"). */
const mentionRe = (names: string[]) => (names.length ? new RegExp(`@(${names.map(escapeRe).sort((a, b) => b.length - a.length).join('|')})(?![\\p{L}\\p{N}_])`, 'giu') : null)
/** The "@par" being typed right before the caret (at the start or after a space), or null. */
function typedMention(value: string, caret: number) {
  const m = value.slice(0, caret).match(/(^|\s)@([\p{L}\p{N}_]{0,30})$/u)
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null
}

const keyOf = (draftKey: string) => `after-office:chat-draft:${draftKey}`
const SAVE_AFTER_MS = 250
const MAX_DRAFT = 20_000

function readDraft(draftKey: string) {
  try {
    return localStorage.getItem(keyOf(draftKey)) ?? ''
  } catch {
    return ''
  }
}
function writeDraft(draftKey: string, v: string) {
  try {
    if (v.trim()) localStorage.setItem(keyOf(draftKey), v.slice(0, MAX_DRAFT))
    else localStorage.removeItem(keyOf(draftKey))
  } catch {
    // private mode or full: the draft just isn't kept
  }
}

export const ComposerBox = forwardRef<ComposerHandle, {
  /** which draft this is: the agent and its session */
  draftKey: string
  placeholder: string
  disabled?: boolean
  /** Enter (without Shift) sends: not on phones, where Enter is a new line and the send button sends */
  enterSends?: boolean
  onSubmit: () => void
  /** pictures or files pasted into the box */
  onFiles: (files: File[]) => void
  /** whether there's anything typed: the one thing the chat needs to know on each keystroke (it only renders when it flips) */
  onHasText: (has: boolean) => void
  /** names the message can mention: typing @ offers them, and a mentioned one shows in the accent colour */
  mentions?: Mentionable[]
}>(function ComposerBox({ draftKey, placeholder, disabled, enterSends = true, onSubmit, onFiles, onHasText, mentions }, ref) {
  const [value, setValue] = useState(() => readDraft(draftKey))
  const el = useRef<HTMLTextAreaElement>(null)
  const latest = useRef(value)
  latest.current = value
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // @: the names offered for what's typed after it (the arrow keys move, Enter or Tab picks, Esc closes)
  const [menu, setMenu] = useState<{ start: number; query: string; index: number } | null>(null)
  const options = useMemo(
    () => (menu && mentions ? mentions.filter((m) => m.name.toLowerCase().startsWith(menu.query.toLowerCase())).slice(0, 8) : []),
    [menu, mentions],
  )
  const look = (v: string, caret: number | null) => {
    if (!mentions?.length || caret === null) return setMenu(null)
    const at = typedMention(v, caret)
    setMenu((m) => (at ? { ...at, index: m && m.start === at.start ? m.index : 0 } : null))
  }
  const pick = (name: string) => {
    const t = el.current
    if (!t || !menu) return
    const caret = t.selectionStart ?? latest.current.length
    const next = `${latest.current.slice(0, menu.start)}@${name} ${latest.current.slice(caret)}`
    change(next)
    setMenu(null)
    const at = menu.start + name.length + 2
    requestAnimationFrame(() => {
      t.focus()
      t.setSelectionRange(at, at)
    })
  }
  // the text again behind the box, with the mentioned names in colour (the box's own text is see-through)
  const re = useMemo(() => mentionRe((mentions ?? []).map((m) => m.name)), [mentions])
  const mirror = useRef<HTMLDivElement>(null)
  const painted = useMemo(() => {
    if (!re) return null
    const out: ReactNode[] = []
    let last = 0
    for (const m of value.matchAll(re)) {
      out.push(value.slice(last, m.index), <mark key={m.index}>{m[0]}</mark>)
      last = m.index! + m[0].length
    }
    out.push(value.slice(last), '\u200b')
    return out
  }, [value, re])

  const flush = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    writeDraft(draftKey, latest.current)
  }
  const change = (v: string) => {
    latest.current = v
    setValue(v)
    onHasText(!!v.trim())
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_AFTER_MS)
  }
  useImperativeHandle(
    ref,
    () => ({
      get: () => latest.current,
      set: (v) => {
        latest.current = v
        setValue(v)
        onHasText(!!v.trim())
        // saved right away: a send empties it for good
        if (timer.current) clearTimeout(timer.current)
        timer.current = null
        writeDraft(draftKey, v)
      },
      focus: (opts) => el.current?.focus(opts),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draftKey],
  )
  // a draft that came back: the chat knows there's text (the send button, the stop square)
  useEffect(() => {
    onHasText(!!latest.current.trim())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // kept when the chat closes, the page is left, or the phone puts the app in the background (it may never come back)
  useEffect(() => {
    const away = () => flush()
    const hidden = () => document.visibilityState === 'hidden' && flush()
    window.addEventListener('pagehide', away)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('pagehide', away)
      document.removeEventListener('visibilitychange', hidden)
      flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey])

  // the box grows with what's typed, up to its max-height (CSS), then scrolls
  useLayoutEffect(() => {
    const t = el.current
    if (!t) return
    const fit = () => {
      t.style.height = 'auto'
      t.style.height = `${t.scrollHeight + (t.offsetHeight - t.clientHeight)}px`
      // a scrollbar only once it's at its max-height and there's more
      t.style.overflowY = t.scrollHeight > t.clientHeight + 1 ? 'auto' : 'hidden'
      // the coloured copy lines up with the box: same box, same text metrics, same scroll
      const m = mirror.current
      if (m) {
        const cs = getComputedStyle(t)
        for (const k of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing', 'borderRadius'] as const)
          m.style[k] = cs[k]
        m.style.height = t.style.height
        m.scrollTop = t.scrollTop
      }
    }
    fit()
    // measured while the panel was still opening (narrow): measure again once its width settles
    let width = t.clientWidth
    const ro = new ResizeObserver(() => {
      if (t.clientWidth === width) return
      width = t.clientWidth
      fit()
    })
    ro.observe(t)
    return () => ro.disconnect()
  }, [value])

  const box = (
    <textarea
      ref={el}
      value={value}
      className={re ? 'composer-field__input' : undefined}
      onChange={(e) => (change(e.target.value), look(e.target.value, e.target.selectionStart))}
      onSelect={(e) => mentions && look(e.currentTarget.value, e.currentTarget.selectionStart)}
      onBlur={() => setTimeout(() => setMenu(null), 150)}
      onScroll={(e) => mirror.current && (mirror.current.scrollTop = e.currentTarget.scrollTop)}
      onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
        // the @ menu takes the arrows, Enter / Tab and Esc while it's open
        if (menu && options.length) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const step = e.key === 'ArrowDown' ? 1 : -1
            return setMenu({ ...menu, index: (menu.index + step + options.length) % options.length })
          }
          if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
            e.preventDefault()
            return pick(options[Math.min(menu.index, options.length - 1)].name)
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            return setMenu(null)
          }
        }
        // a touch keyboard's Enter is a new line (a tablet with a touch screen too): only a real keyboard's sends
        const touch = typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches
        if (enterSends && !touch && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault()
          onSubmit()
        }
      }}
      onPaste={(e: ClipboardEvent<HTMLTextAreaElement>) => {
        // pasted pictures / files become attachments; pasted text stays text
        const files = [...e.clipboardData.files]
        if (!files.length) return
        e.preventDefault()
        onFiles(files)
      }}
      rows={1}
      placeholder={placeholder}
      disabled={disabled}
    />
  )
  if (!mentions) return box
  return (
    <div className="composer-field">
      {box}
      {re && (
        <div ref={mirror} className="composer-field__mirror" aria-hidden>
          {painted}
        </div>
      )}
      {menu && options.length > 0 && (
        <div className="popover composer-mentions" role="listbox" aria-label="Mention">
          {options.map((o, i) => (
            <button
              key={o.name}
              type="button"
              role="option"
              aria-selected={i === menu.index}
              className={`composer-mentions__item${i === menu.index ? ' is-active' : ''}`}
              // before the box loses focus (its blur closes this)
              onMouseDown={(e) => (e.preventDefault(), pick(o.name))}
              onMouseEnter={() => setMenu({ ...menu, index: i })}
            >
              <span className="avatar avatar--xs" style={avatarStyle(o.color)}>
                {o.name[0]}
              </span>
              <span className="truncate">{o.name}</span>
              {o.role && <span className="muted truncate">{o.role}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
})
