/**
 * An HTML file shown as the page it is (its layout, text and inline styles), in a sandboxed frame: its scripts don't
 * run, and it can't reach the office, its cookies or its storage, open popups or navigate the dashboard away. Files it
 * points to by a relative path (its own CSS, pictures) don't load: it's shown from its text, not from its folder.
 */
export function HtmlFrame({ html, title }: { html: string; title: string }) {
  return <iframe className="html-frame" title={title} srcDoc={withBase(html)} sandbox="" referrerPolicy="no-referrer" />
}

/** The plain look added at the top of its head (after a doctype: before it, the page would render in quirks mode). */
function withBase(html: string) {
  const head = /<head[^>]*>/i.exec(html)
  if (head) return html.slice(0, head.index + head[0].length) + BASE + html.slice(head.index + head[0].length)
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  if (doctype) return doctype[0] + BASE + html.slice(doctype[0].length)
  return BASE + html
}

/**
 * A plain look underneath the page's own: tables with simple borders (an article's often have none of their own),
 * pictures that fit. `:where()` weighs nothing, so whatever the file styles itself wins.
 */
const BASE = `<style>
:where(body) { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.5; margin: 16px; }
:where(table) { border-collapse: collapse; margin: 1em 0; max-width: 100%; display: block; overflow-x: auto; }
:where(th, td) { border: 1px solid #d0d0d0; padding: 6px 10px; text-align: left; vertical-align: top; }
:where(th) { background: #f4f4f4; font-weight: 600; }
:where(img, video) { max-width: 100%; height: auto; }
</style>`
