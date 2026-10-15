import { useState } from 'react'
import { LuCheck, LuCopy } from 'react-icons/lu'

/** What a copy puts on the clipboard: its text, and (a page) the page too, so pasting into a document keeps its look. */
export type Copied = { text: string; html?: string }

/**
 * A window's copy button: what `get` gives (read when pressed: the view showing then, a page or its code), and a tick
 * for a moment once it's copied.
 */
export function CopyButton({ get, label = 'Copy' }: { get: () => Copied; label?: string }) {
  const [done, setDone] = useState<'ok' | 'failed' | null>(null)
  const copy = async () => {
    const ok = await toClipboard(get())
    setDone(ok ? 'ok' : 'failed')
    setTimeout(() => setDone(null), 1500)
  }
  const tip = done === 'ok' ? 'Copied' : done === 'failed' ? 'Could not copy' : label
  return (
    <button className="icon-btn small ghost" data-tip={tip} aria-label={tip} onClick={() => void copy()}>
      {done === 'ok' ? <LuCheck /> : <LuCopy />}
    </button>
  )
}

async function toClipboard({ text, html }: Copied) {
  try {
    if (html && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })])
      return true
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // refused (or not a secure page): the old way below
  }
  // plain http (the dashboard on the LAN): no clipboard API, the old way still works
  const box = document.createElement('textarea')
  box.value = text
  box.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
  document.body.appendChild(box)
  box.select()
  const ok = document.execCommand('copy')
  box.remove()
  return ok
}

/** A page's words as plain text, a line per block (its scripts and styles left out; nothing of it runs). */
export function pageText(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script, style, noscript, template').forEach((n) => n.remove())
  doc.querySelectorAll('br').forEach((n) => n.replaceWith('\n'))
  doc.querySelectorAll('li').forEach((n) => n.prepend('- '))
  doc.querySelectorAll('td, th').forEach((n) => n.append('\t'))
  doc.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6, pre, blockquote, section, article, header, footer, table, ul, ol').forEach((n) => n.append('\n'))
  return (doc.body.textContent ?? '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** What a rendered view shows (Markdown as a page): its words, and itself as a page. */
export const shown = (el: HTMLElement): Copied => ({ text: el.innerText.trim(), html: el.innerHTML })
