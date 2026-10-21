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

test('code blocks keep their language, tables and callouts survive the trip', () => {
  const md = [
    '```ts\nconst a: number = 1\n```',
    '| Nama | Status |\n| --- | --- |\n| Tes \\| satu | **beres** |\n| dua |  |',
    '> 💡 Ingat ini\n>\n> - poin',
    '> ⚠️ Hati-hati',
    '> kutipan\n>\n> paragraf kedua',
    'Kirim ke [email](mailto:owner@aftrn.com).',
  ].join('\n\n')
  expect(htmlToMarkdown(markdownToHtml(md))).toBe(md)
})

test("the editor's table, callout and code block read as Markdown", () => {
  const html =
    '<table style="min-width: 50px"><colgroup><col style="min-width: 25px"><col style="min-width: 25px"></colgroup><tbody>' +
    '<tr><th colspan="1" rowspan="1"><p>A</p></th><th colspan="1" rowspan="1"><p>B</p></th></tr>' +
    '<tr><td colspan="1" rowspan="1"><p>1</p><p>baris</p></td><td colspan="1" rowspan="1"><p></p></td></tr></tbody></table>' +
    '<div data-type="callout" data-emoji="📌"><p>Penting</p><div data-type="callout" data-emoji="💡"><p>dalam</p></div></div>' +
    '<pre><code class="language-python">print(1 &lt; 2)</code></pre>'
  expect(htmlToMarkdown(html)).toBe('| A | B |\n| --- | --- |\n| 1 baris |  |\n\n> 📌 Penting\n>\n> > 💡 dalam\n\n```python\nprint(1 < 2)\n```')
})

test('a link that is not the web or e-mail is just its text, both ways', () => {
  expect(htmlToMarkdown('<p><a href="javascript:alert(1)">klik</a></p>')).toBe('klik')
  expect(markdownToHtml('[x](mailto:a@b.co) [y](data:text/html,hi)')).toBe('<p><a href="mailto:a@b.co">x</a> [y](data:text/html,hi)</p>')
  // a ⚠ without its emoji selector is still the warning callout; an unknown icon is a quote
  expect(markdownToHtml('> ⚠ awas')).toBe('<div data-type="callout" data-emoji="⚠️"><p>awas</p></div>')
  expect(markdownToHtml('> 🙂 halo')).toBe('<blockquote><p>🙂 halo</p></blockquote>')
})

test('headings go down to level 6, both ways', () => {
  const md = '# Satu\n\n## Dua\n\n### Tiga\n\n#### Empat\n\n##### Lima\n\n###### Enam'
  expect(markdownToHtml(md)).toBe('<h1>Satu</h1><h2>Dua</h2><h3>Tiga</h3><h4>Empat</h4><h5>Lima</h5><h6>Enam</h6>')
  expect(htmlToMarkdown(markdownToHtml(md))).toBe(md)
  // seven is just text
  expect(markdownToHtml('####### tujuh')).toBe('<p>####### tujuh</p>')
})

test("a drawing reads as a stand-in with its strokes counted, and isn't drawn back from Markdown", () => {
  const strokes = JSON.stringify([['pen', 'ink', 2, [1, 2, 3.5, 4]], ['marker', 'orange', 3, [10, 10, 20, 20]]]).replace(/"/g, '&quot;')
  const html = `<p>Sketsa:</p><div data-type="drawing" data-width="800" data-height="320" data-strokes="${strokes}"></div><p>sesudah</p>`
  expect(htmlToMarkdown(html)).toBe('Sketsa:\n\n[drawing: 2 strokes]\n\nsesudah')
  expect(htmlToMarkdown('<div data-type="drawing" data-strokes="[]"></div>')).toBe('[drawing: 0 strokes]')
  expect(htmlToMarkdown('<div data-type="drawing" data-strokes="oops"></div>')).toBe('[drawing: 0 strokes]')
  // an agent's text with the stand-in: it's left out, the rest stays
  expect(markdownToHtml('Sketsa:\n\n[drawing: 2 strokes]\n\nsesudah')).toBe('<p>Sketsa:</p><p>sesudah</p>')
  expect(markdownToHtml('lihat [drawing: 1 stroke] di atas')).toBe('<p>lihat [drawing: 1 stroke] di atas</p>')
})

test('a font size on some text is dropped in Markdown, its words kept', () => {
  expect(htmlToMarkdown('<p>Teks <span style="font-size: 20px">besar</span> dan <strong><span style="font-size: 12px">kecil</span></strong></p>')).toBe('Teks besar dan **kecil**')
})
