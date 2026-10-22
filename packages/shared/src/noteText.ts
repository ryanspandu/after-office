// Notes are rich text (TipTap's HTML) in the dashboard; agents read and write them as Markdown. Both ways cover what
// the editor makes: headings, paragraphs, lists (bulleted, numbered, checklists), quotes, callouts ("> 💡 …"), code
// blocks (with their language), tables (GFM, plain text cells), rules, collapsible sections (<details>), bold, italic,
// strike, underline (<u>), highlight (==…== or <mark data-color>), text colour and size (<span style>), inline code, links
// and the note's own pictures (/api/note-images/…). A drawing (ui/NoteDrawing.tsx) reads as "[drawing: N strokes]" and isn't made
// back from it (an agent's Markdown has no drawings). Anything else is kept as its text.

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Inline markup → Markdown (bold, italic, strike, code, links, line breaks); other tags dropped. */
function inlineMd(html: string) {
  return decode(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      // underline, highlight, colour / size: kept as their own small HTML (no Markdown for them), past the tag strip below
      .replace(/<u\b[^>]*>([\s\S]*?)<\/u>/gi, `${LT}u${GT}$1${LT}/u${GT}`)
      .replace(/<mark\b([^>]*)>([\s\S]*?)<\/mark>/gi, (_m, attrs: string, text: string) => {
        const color = safeColor(attr(`<x ${attrs}>`, 'data-color'))
        return color ? `${LT}mark data-color="${color}"${GT}${text}${LT}/mark${GT}` : `==${text}==`
      })
      .replace(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi, (_m, attrs: string, text: string) => {
        const style = safeStyle(decode(attr(`<x ${attrs}>`, 'style')))
        return style ? `${LT}span style="${style}"${GT}${text}${LT}/span${GT}` : text
      })
      .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
      .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
      .replace(/<(s|del|strike)\b[^>]*>([\s\S]*?)<\/\1>/gi, '~~$2~~')
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
      .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => (SAFE_HREF.test(decode(href)) ? `[${text}](${href})` : text))
      .replace(/<img\b[^>]*>/gi, imageMd)
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\uE000/g, '<')
    .replace(/\uE001/g, '>')
    .trim()
}

/** Stand-ins for "<" and ">" of the tags inlineMd keeps (its last step strips every other tag). */
const LT = '\uE000'
const GT = '\uE001'
/** A colour as the editor writes it: #hex, rgb()/rgba(), or a plain name. */
const safeColor = (v: string) => (/^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.\s,%]+\)|[a-z]{3,20})$/i.test(v.trim()) ? v.trim() : '')
/** A text style an agent may read or write: its colour and its size, nothing else. */
function safeStyle(style: string) {
  const out: string[] = []
  for (const part of style.split(';')) {
    const [k, ...rest] = part.split(':')
    const key = k?.trim().toLowerCase()
    const v = rest.join(':').trim()
    if (key === 'color' && safeColor(v)) out.push(`color: ${safeColor(v)}`)
    else if (key === 'font-size' && /^\d{1,3}(\.\d+)?(px|pt|em|rem)$/.test(v)) out.push(`font-size: ${v}`)
  }
  return out.join('; ')
}

/** A link an agent may read or write: the web or an e-mail address (no javascript:, data: …). */
const SAFE_HREF = /^(https?:\/\/|mailto:)/i
/** The callout's icons (the editor's emoji button cycles through them); ⚠ may come without its emoji selector. */
export const CALLOUT_EMOJIS = ['💡', '⚠️', '✅', '❗', '📌']
const CALLOUT_LINE = /^(💡|⚠\uFE0F?|✅|❗|📌)\s+/u

/** The top-level blocks of some HTML, each whole (a callout's own <div>s or a nested section stay inside it). */
const BLOCK_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'blockquote', 'pre', 'div', 'details', 'table'])
function topBlocks(html: string) {
  const out: string[] = []
  let depth = 0
  let start = 0
  let name = ''
  for (const m of html.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*?(\/?)>/gi)) {
    const tag = m[2].toLowerCase()
    const close = m[1] === '/'
    if (!depth) {
      if (close) continue
      if (tag === 'hr' || tag === 'img') out.push(m[0])
      else if (BLOCK_TAGS.has(tag) && !m[3]) (start = m.index), (name = tag), (depth = 1)
      continue
    }
    if (tag !== name || m[3]) continue
    depth += close ? -1 : 1
    if (!depth) out.push(html.slice(start, m.index + m[0].length))
  }
  return out.length ? out : [html]
}
/** What's inside a block's outer tag. */
const innerOf = (block: string) => block.replace(/^<[^>]+>/, '').replace(/<\/[a-z0-9]+>\s*$/i, '')
/** Markdown lines as a quote ("> "), the first one led by a callout's icon. */
const quoted = (md: string, lead = '') => (lead + md).split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')

/** A table as GFM: the first row is its header; each cell's text on one line ("|" escaped). */
function tableMd(html: string) {
  const rows = (html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []).map((tr) =>
    (tr.match(/<t[hd]\b[^>]*>[\s\S]*?<\/t[hd]>/gi) ?? []).map((td) =>
      inlineMd(td.replace(/<\/(p|h[1-6]|li)>\s*<(p|h[1-6]|li)\b[^>]*>/gi, ' ')).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|'),
    ),
  )
  if (!rows.length) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`
  return [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n')
}

/** Where a note's picture may be: one stored by the dashboard, nothing else. */
const OWN_IMAGE = /^\/api\/note-images\/[0-9a-f-]{36}\.(png|jpg|gif|webp)$/
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'))?.[1] ?? ''
/** A picture as Markdown, ![alt](src) (an outside one: just its text). */
const imageMd = (tag: string) => {
  const src = attr(tag, 'src')
  return OWN_IMAGE.test(src) ? `![${attr(tag, 'alt')}](${src})` : attr(tag, 'alt')
}

/** A drawing's stand-in for an agent: how many strokes it has (its data-strokes, a JSON list). */
const drawingMd = (tag: string) => {
  let n = 0
  try {
    const strokes: unknown = JSON.parse(decode(attr(tag, 'data-strokes')) || '[]')
    if (Array.isArray(strokes)) n = strokes.length
  } catch {
    // unreadable: none
  }
  return `[drawing: ${n} stroke${n === 1 ? '' : 's'}]`
}
/** That stand-in, on a line of its own in an agent's Markdown: left out (it can't be drawn back). */
const DRAWING_LINE = /^\s*\[drawing: \d+ strokes?\]\s*$/

/** A note's HTML as Markdown, for an agent to read. */
export function htmlToMarkdown(html: string): string {
  const out: string[] = []
  // block by block: a top-level tag and what's inside it
  for (const b of topBlocks(html)) {
    const tag = (b.match(/^<(\w+)/)?.[1] ?? '').toLowerCase()
    if (tag === 'hr') out.push('---')
    else if (tag === 'img') {
      const md = imageMd(b)
      if (md) out.push(md)
    }
    else if (/^h[1-6]$/.test(tag)) out.push(`${'#'.repeat(Number(tag[1]))} ${inlineMd(b)}`)
    else if (tag === 'pre') {
      // its language (TipTap: <code class="language-js">), after the fence
      const lang = b.match(/class="[^"]*\blanguage-([\w+#-]+)/i)?.[1] ?? ''
      out.push('```' + lang + '\n' + decode(b.replace(/<[^>]+>/g, '')).replace(/\n$/, '') + '\n```')
    }
    else if (tag === 'table') {
      const md = tableMd(b)
      if (md) out.push(md)
    }
    else if (tag === 'div' && /^<div\b[^>]*data-type="callout"/i.test(b)) {
      const emoji = attr(b.match(/^<[^>]+>/)![0], 'data-emoji')
      out.push(quoted(htmlToMarkdown(innerOf(b)), `${CALLOUT_EMOJIS.includes(emoji) ? emoji : CALLOUT_EMOJIS[0]} `))
    }
    else if (tag === 'div' && /^<div\b[^>]*data-type="drawing"/i.test(b)) out.push(drawingMd(b.match(/^<[^>]+>/)![0]))
    else if (tag === 'blockquote') out.push(quoted(htmlToMarkdown(innerOf(b))))
    else if (tag === 'ul' || tag === 'ol') {
      const items = b.match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) ?? []
      const lines: string[] = []
      items.forEach((li, i) => {
        const checked = /data-checked="true"/.test(li)
        const task = /data-type="taskItem"/.test(li) || /data-checked=/.test(li)
        const mark = task ? `- [${checked ? 'x' : ' '}] ` : tag === 'ol' ? `${i + 1}. ` : '- '
        lines.push(mark + inlineMd(li.replace(/<label\b[\s\S]*?<\/label>/gi, '')).replace(/\n+/g, ' '))
      })
      out.push(lines.join('\n'))
    } else if (tag === 'details') {
      // a collapsible section: <details>, its title in <summary>, what it folds away in Markdown between them
      const summary = b.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)?.[1] ?? ''
      const rest = b.replace(/<summary\b[\s\S]*?<\/summary>/i, '').replace(/^<details[^>]*>|<\/details>$/gi, '')
      // the editor keeps the folded part in its own <div data-type="detailsContent">
      const inner = htmlToMarkdown(topBlocks(rest).map((x) => (/^<div\b[^>]*data-type="detailsContent"/i.test(x) ? innerOf(x) : x)).join(''))
      out.push(['<details>', `<summary>${inlineMd(summary).replace(/\n+/g, ' ')}</summary>`, '', ...(inner ? [inner, ''] : []), '</details>'].join('\n'))
    } else {
      const t = inlineMd(b)
      if (t) out.push(t)
    }
  }
  return out.join('\n\n').trim()
}

/** Inline Markdown → HTML (escaped first). */
function inlineHtml(md: string) {
  return escape(md)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>')
    // the small HTML an agent may use (escaped above): underline, a coloured highlight, a text colour / size
    .replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, '<u>$1</u>')
    .replace(/&lt;mark data-color=&quot;([^&]*)&quot;&gt;([\s\S]*?)&lt;\/mark&gt;/g, (m, c: string, text: string) => {
      const color = safeColor(c)
      return color ? `<mark data-color="${color}" style="background-color: ${color}; color: inherit">${text}</mark>` : `<mark>${text}</mark>`
    })
    .replace(/&lt;span style=&quot;([^&]*)&quot;&gt;([\s\S]*?)&lt;\/span&gt;/g, (_m, st: string, text: string) => {
      const style = safeStyle(st)
      return style ? `<span style="${style}">${text}</span>` : text
    })
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, '<a href="$2">$1</a>')
}

/** A table's "| --- | :-: |" line. */
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/
/** A table row's cells ("\\|" is a "|" in a cell). */
const cellsOf = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/(^|[^\\])\|$/, '$1')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'))

/** An agent's Markdown as the editor's HTML. */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let para: string[] = []
  let list: { kind: 'ul' | 'ol' | 'task'; items: string[] } | null = null
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inlineHtml).join('<br>')}</p>`)
    para = []
  }
  const flushList = () => {
    if (!list) return
    if (list.kind === 'task') out.push(`<ul data-type="taskList">${list.items.join('')}</ul>`)
    else out.push(`<${list.kind}>${list.items.join('')}</${list.kind}>`)
    list = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^```/.test(line)) {
      flushPara()
      flushList()
      // its language after the fence ("```ts"): the editor's code block shows and colours it
      const lang = line.slice(3).trim().match(/^[\w+#-]{1,30}$/)?.[0]
      const code: string[] = []
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i])
      out.push(`<pre><code${lang ? ` class="language-${escape(lang.toLowerCase())}"` : ''}>${escape(code.join('\n'))}</code></pre>`)
      continue
    }
    // a collapsible section: "<details>", "<summary>Title</summary>", its Markdown, "</details>" (sections inside it too)
    if (/^\s*<details>\s*$/i.test(line)) {
      flushPara()
      flushList()
      const inner: string[] = []
      let depth = 1
      for (i++; i < lines.length; i++) {
        if (/^\s*<details>\s*$/i.test(lines[i])) depth++
        else if (/^\s*<\/details>\s*$/i.test(lines[i]) && !--depth) break
        inner.push(lines[i])
      }
      const first = inner.findIndex((l) => l.trim())
      const title = first >= 0 ? inner[first].match(/^\s*<summary>([\s\S]*?)<\/summary>\s*$/i) : null
      if (title) inner.splice(first, 1)
      out.push(`<details><summary>${inlineHtml(title?.[1] ?? '')}</summary><div data-type="detailsContent">${markdownToHtml(inner.join('\n')) || '<p></p>'}</div></details>`)
      continue
    }
    // a table (GFM): a row of cells, then its "| --- |" line, then its rows
    if (/^\s*\|/.test(line) && TABLE_RULE.test(lines[i + 1] ?? '')) {
      flushPara()
      flushList()
      const rows = [cellsOf(line)]
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(cellsOf(lines[i]))
      i--
      const width = rows[0].length
      const row = (cells: string[], tag: 'th' | 'td') => `<tr>${Array.from({ length: width }, (_, c) => `<${tag}><p>${inlineHtml(cells[c] ?? '')}</p></${tag}>`).join('')}</tr>`
      out.push(`<table><tbody>${row(rows[0], 'th')}${rows.slice(1).map((r) => row(r, 'td')).join('')}</tbody></table>`)
      continue
    }
    // a quote: its lines together (paragraphs, lists… inside); led by a callout's icon, a callout
    if (/^>/.test(line)) {
      flushPara()
      flushList()
      const inner: string[] = []
      for (; i < lines.length && /^>/.test(lines[i]); i++) inner.push(lines[i].replace(/^>\s?/, ''))
      i--
      const icon = inner[0].match(CALLOUT_LINE)
      if (icon) {
        inner[0] = inner[0].slice(icon[0].length)
        const emoji = icon[1].startsWith('⚠') ? '⚠️' : icon[1]
        out.push(`<div data-type="callout" data-emoji="${emoji}">${markdownToHtml(inner.join('\n')) || '<p></p>'}</div>`)
      } else out.push(`<blockquote>${markdownToHtml(inner.join('\n')) || '<p></p>'}</blockquote>`)
      continue
    }
    const task = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/)
    const bullet = !task && line.match(/^\s*[-*]\s+(.*)$/)
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    // a picture on its own line: only one of the note's own (an agent can't point the dashboard elsewhere)
    const image = line.match(/^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/)
    if (image && OWN_IMAGE.test(image[2])) {
      flushPara()
      flushList()
      out.push(`<img src="${escape(image[2])}" alt="${escape(image[1])}">`)
      continue
    }
    if (DRAWING_LINE.test(line)) {
      flushPara()
      flushList()
      continue
    }
    if (task || bullet || numbered) {
      flushPara()
      const kind = task ? 'task' : bullet ? 'ul' : 'ol'
      if (list && list.kind !== kind) flushList()
      list ??= { kind, items: [] }
      if (task) list.items.push(`<li data-type="taskItem" data-checked="${task[1].toLowerCase() === 'x'}"><p>${inlineHtml(task[2])}</p></li>`)
      else list.items.push(`<li><p>${inlineHtml((bullet || numbered)![1])}</p></li>`)
      continue
    }
    flushList()
    if (heading) {
      flushPara()
      out.push(`<h${heading[1].length}>${inlineHtml(heading[2])}</h${heading[1].length}>`)
    } else if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flushPara()
      out.push('<hr>')
    } else if (!line.trim()) flushPara()
    else para.push(line)
  }
  flushPara()
  flushList()
  return out.join('')
}
