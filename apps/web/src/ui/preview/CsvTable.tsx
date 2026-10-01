import { useMemo } from 'react'

// A CSV / TSV file as a table: the first row is the header (sticky), wide tables scroll sideways, big files show their
// first rows only. Quoted fields ("a, b", "say ""hi""", line breaks inside quotes) stay one cell.

const MAX_ROWS = 1000

/** The separator: tab for .tsv; otherwise whichever of , ; tab appears most in the first line (outside quotes). */
function separatorOf(text: string, path: string) {
  if (/\.tsv$/i.test(path)) return '\t'
  const first = text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n'))
  const counts = { ',': 0, ';': 0, '\t': 0 }
  let quoted = false
  for (const ch of first) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch in counts) counts[ch as keyof typeof counts]++
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  return n > 0 ? best : ','
}

/** Rows of cells (RFC 4180-ish), at most `limit` rows; `more`: rows left out. */
export function parseCsv(text: string, sep: string, limit = MAX_ROWS): { rows: string[][]; more: number } {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let more = 0
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text // a BOM (Excel) isn't part of the first header
  const endRow = () => {
    row.push(cell)
    cell = ''
    if (!(row.length === 1 && row[0] === '')) {
      if (rows.length < limit) rows.push(row)
      else more++
    }
    row = []
  }
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === sep) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      endRow()
    } else cell += ch
  }
  if (cell !== '' || row.length) endRow()
  return { rows, more }
}

export function CsvTable({ text, path }: { text: string; path: string }) {
  const { rows, more } = useMemo(() => parseCsv(text, separatorOf(text, path)), [text, path])
  if (!rows.length) return <div className="muted">This file is empty.</div>
  const [head, ...body] = rows
  const cols = Math.max(...rows.map((r) => r.length))
  const pad = (r: string[]) => [...r, ...Array(cols - r.length).fill('')]
  return (
    <div className="csv">
      <div className="csv__scroll">
        <table className="csv__table">
          <thead>
            <tr>
              <th className="csv__n" />
              {pad(head).map((c, i) => (
                <th key={i}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, i) => (
              <tr key={i}>
                <td className="csv__n">{i + 1}</td>
                {pad(r).map((c, j) => (
                  <td key={j}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="csv__foot muted">
        {body.length} row{body.length === 1 ? '' : 's'} · {cols} column{cols === 1 ? '' : 's'}
        {more > 0 && ` · showing the first ${MAX_ROWS} rows (${more} more in the file)`}
      </div>
    </div>
  )
}
