import { useEffect, useState } from 'react'
import DOMPurify from 'dompurify'
// the browser build (mammoth's main entry is for Node)
import mammoth from 'mammoth/mammoth.browser'

// A Word document (.docx) as a readable page: headings, lists, tables, pictures. Turned into HTML by mammoth, then
// cleaned (DOMPurify: no scripts, no handlers, no forms) before it's shown. Loaded only when a .docx is opened.

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  // links leave the dashboard in a new tab, without a way back into it
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

export default function DocxView({ data }: { data: ArrayBuffer }) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let gone = false
    mammoth.convertToHtml({ arrayBuffer: data.slice(0) }).then(
      (r: { value: string }) => !gone && setHtml(DOMPurify.sanitize(r.value, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button'] })),
      (e: Error) => !gone && setError(e.message || 'Could not read this document'),
    )
    return () => void (gone = true)
  }, [data])
  if (error) return <div className="row__error">{error}</div>
  if (html === null) return <div className="muted">Loading…</div>
  if (!html.trim()) return <div className="muted">This document has no text.</div>
  return <div className="docx" dangerouslySetInnerHTML={{ __html: html }} />
}
