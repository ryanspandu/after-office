// What of an agent's reply is read out (state/speech.ts): pure, for tests.

/** About this much is read (a few short paragraphs); the rest is in the chat. */
const MAX_CHARS = 700

/** What can be said of a reply: its words, without code, tables, links' addresses, paths or markdown marks. */
export function speakable(markdown: string) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .filter((l) => !/^\s*\|/.test(l))
    .join('\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, (_, code: string) => (/[/\\]/.test(code) || code.length > 30 ? ' ' : code))
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(^|\s)[~.]?\/[\w./-]+/g, ' ')
    .replace(/^#+\s*/gm, '')
    // list items: a pause after each
    .replace(/^\s*(?:[-*+]|\d+\.)\s+(.*?)[.,;:!?]?\s*$/gm, '$1.')
    .replace(/[*_>#~]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    // what's left where a path or a link was taken out: "di .", ". . ." → tidy punctuation
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/([.,!?;:])(?:\s*[.,;:])+/g, '$1')
    .replace(/\b(di|ke|dari|at|in|to|from|see|lihat)\.\s/gi, '. ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/([.!?])(?:\s*[.,;:])+/g, '$1')
    .replace(/^[.,\s]+/, '')
    .trim()
  if (text.length <= MAX_CHARS) return text
  // cut at the end of a sentence
  const cut = text.slice(0, MAX_CHARS)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  return `${end > MAX_CHARS / 2 ? cut.slice(0, end + 1) : cut}`.trim()
}

