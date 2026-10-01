import { useEffect, useRef, useState } from 'react'
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// A PDF drawn page by page (pdf.js, no browser plugin: works the same on phones, where a framed PDF shows one page).
// Loaded only when a PDF is opened. pdf.js never evals and doesn't run a PDF's own scripts.

GlobalWorkerOptions.workerSrc = workerUrl
const MAX_PAGES = 100

export default function PdfView({ data }: { data: ArrayBuffer }) {
  const box = useRef<HTMLDivElement>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    let gone = false
    // pdf.js takes the buffer over: hand it a copy, so a re-render can read it again
    const task = getDocument({ data: data.slice(0), useWasm: false })
    task.promise.then(
      (d) => !gone && setDoc(d),
      (e: Error) => !gone && setError(e.message || 'Could not read this PDF'),
    )
    return () => {
      gone = true
      void task.destroy()
    }
  }, [data])

  // pages as wide as the panel (redrawn when it changes size: maximize, phone rotation)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth((w) => (Math.abs(w - el.clientWidth) > 24 ? el.clientWidth : w)))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  if (error) return <div className="row__error">{error}</div>
  const pages = doc ? Math.min(doc.numPages, MAX_PAGES) : 0
  return (
    <div className="pdf" ref={box}>
      {!doc && <div className="muted">Loading…</div>}
      {doc && width > 0 && Array.from({ length: pages }, (_, i) => <PdfPage key={`${i}-${width}`} doc={doc} n={i + 1} width={width} />)}
      {doc && doc.numPages > MAX_PAGES && <div className="muted pdf__more">Showing the first {MAX_PAGES} of {doc.numPages} pages: download it for the rest.</div>}
    </div>
  )
}

function PdfPage({ doc, n, width }: { doc: PDFDocumentProxy; n: number; width: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const holder = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(n <= 2)
  // pages are drawn as they scroll into view (a long PDF opens fast)
  useEffect(() => {
    if (visible || !holder.current) return
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setVisible(true), { rootMargin: '600px' })
    io.observe(holder.current)
    return () => io.disconnect()
  }, [visible])
  const [ratio, setRatio] = useState(1.414)
  useEffect(() => {
    if (!visible) return
    let gone = false
    let render: { cancel: () => void } | null = null
    void doc.getPage(n).then((page) => {
      if (gone || !canvas.current) return
      const base = page.getViewport({ scale: 1 })
      setRatio(base.height / base.width)
      const scale = width / base.width
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const vp = page.getViewport({ scale: scale * dpr })
      const c = canvas.current
      c.width = Math.floor(vp.width)
      c.height = Math.floor(vp.height)
      c.style.width = `${Math.floor(vp.width / dpr)}px`
      c.style.height = `${Math.floor(vp.height / dpr)}px`
      const task = page.render({ canvas: c, viewport: vp })
      render = task
      task.promise.catch(() => undefined)
    })
    return () => {
      gone = true
      render?.cancel()
    }
  }, [doc, n, width, visible])
  return (
    <div className="pdf__page" ref={holder} style={visible ? undefined : { height: Math.round(width * ratio) }}>
      {visible && <canvas ref={canvas} aria-label={`Page ${n}`} />}
    </div>
  )
}
