/**
 * An HTML file shown as the page it is (its layout, text and inline styles), in a sandboxed frame: its scripts don't
 * run, and it can't reach the office, its cookies or its storage, open popups or navigate the dashboard away. Files it
 * points to by a relative path (its own CSS, pictures) don't load: it's shown from its text, not from its folder.
 */
export function HtmlFrame({ html, title }: { html: string; title: string }) {
  return <iframe className="html-frame" title={title} srcDoc={html} sandbox="" referrerPolicy="no-referrer" />
}
