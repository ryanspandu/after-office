import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'

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
  /** Enter (without Shift) */
  onSubmit: () => void
  /** pictures or files pasted into the box */
  onFiles: (files: File[]) => void
  /** whether there's anything typed: the one thing the chat needs to know on each keystroke (it only renders when it flips) */
  onHasText: (has: boolean) => void
}>(function ComposerBox({ draftKey, placeholder, disabled, onSubmit, onFiles, onHasText }, ref) {
  const [value, setValue] = useState(() => readDraft(draftKey))
  const el = useRef<HTMLTextAreaElement>(null)
  const latest = useRef(value)
  latest.current = value
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  return (
    <textarea
      ref={el}
      value={value}
      onChange={(e) => change(e.target.value)}
      onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
})
