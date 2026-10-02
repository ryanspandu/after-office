// Notes are rich text (TipTap's HTML) in the dashboard; agents read and write them as Markdown. Both ways cover what
// the editor makes: headings, paragraphs, lists (bulleted, numbered, checklists), quotes, code blocks, rules, bold,
// italic, strike, inline code and links. Anything else is kept as its text.

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
      .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
      .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
      .replace(/<(s|del|strike)\b[^>]*>([\s\S]*?)<\/\1>/gi, '~~$2~~')
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
      .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
      .replace(/<[^>]+>/g, ''),
  ).trim()
}

/** A note's HTML as Markdown, for an agent to read. */
export function htmlToMarkdown(html: string): string {
  const out: string[] = []
  // block by block: a top-level tag and what's inside it
  const blocks = html.match(/<(h[1-6]|p|ul|ol|blockquote|pre|hr|div|details)\b[^>]*>[\s\S]*?<\/\1>|<hr\b[^>]*\/?>/gi) ?? [html]
  for (const b of blocks) {
    const tag = (b.match(/^<(\w+)/)?.[1] ?? '').toLowerCase()
    if (tag === 'hr') out.push('---')
    else if (/^h[1-6]$/.test(tag)) out.push(`${'#'.repeat(Number(tag[1]))} ${inlineMd(b)}`)
    else if (tag === 'pre') out.push('```\n' + decode(b.replace(/<[^>]+>/g, '')).replace(/\n$/, '') + '\n```')
    else if (tag === 'blockquote') out.push(inlineMd(b.replace(/<\/p>\s*<p[^>]*>/gi, '\n')).split('\n').map((l) => `> ${l}`).join('\n'))
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
      const summary = b.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)?.[1] ?? ''
      out.push(`**${inlineMd(summary)}**`)
      const rest = b.replace(/<summary\b[\s\S]*?<\/summary>/i, '').replace(/^<details[^>]*>|<\/details>$/gi, '')
      const inner = htmlToMarkdown(rest)
      if (inner) out.push(inner)
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
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
}

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
      const code: string[] = []
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i])
      out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`)
      continue
    }
    const task = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/)
    const bullet = !task && line.match(/^\s*[-*]\s+(.*)$/)
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    const heading = line.match(/^(#{1,3})\s+(.*)$/)
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
    } else if (/^>\s?/.test(line)) {
      flushPara()
      out.push(`<blockquote><p>${inlineHtml(line.replace(/^>\s?/, ''))}</p></blockquote>`)
    } else if (!line.trim()) flushPara()
    else para.push(line)
  }
  flushPara()
  flushList()
  return out.join('')
}
