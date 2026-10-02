import { expect, test } from 'bun:test'
import { htmlToMarkdown, markdownToHtml } from './noteText'

// Notes travel between the editor (HTML) and the agents (Markdown): what the editor makes survives the trip.

test('Markdown → the editor and back', () => {
  const md = [
    '# Judul',
    'Paragraf **tebal**, *miring*, ~~coret~~, `kode` dan [link](https://aftrn.com).',
    '- satu\n- dua',
    '1. pertama\n2. kedua',
    '- [x] beres\n- [ ] belum',
    '> kutipan',
    '```\nconst a = 1 < 2\n```',
    '---',
  ].join('\n\n')
  expect(htmlToMarkdown(markdownToHtml(md))).toBe(md)
})

test('what an agent writes is text, never markup', () => {
  expect(markdownToHtml('<script>alert(1)</script> & [x](javascript:alert(1))')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; [x](javascript:alert(1))</p>')
})

test("the editor's collapsible section reads as its summary and its content", () => {
  expect(htmlToMarkdown('<details><summary>Lihat</summary><div data-type="detailsContent"><p>isi</p></div></details>')).toBe('**Lihat**\n\nisi')
})
