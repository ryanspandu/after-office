// remark plugin (no app imports, so it can be tested on its own): path-like text in an agent's Markdown becomes a
// link to #ao-file:<path> when `find` knows the file; ui/fileLinks.tsx renders those links as buttons.

export const FILE_HREF = '#ao-file:'
const ABS = /(^|[\s(`'"*])((?:~|\/)[\w.@~+%-]*(?:\/[\w.@~+%-]+)+\.[A-Za-z0-9]{1,8})(?=$|[\s)`'",;:.!?*])/g
const WHOLE = /^(?:~|\/)?[\w.@~+%-]*(?:\/[\w.@~+%-]+)*\.[A-Za-z0-9]{1,8}$/

type Node = { type: string; value?: string; url?: string; children?: Node[] }

export function remarkFileLinks(options: { find: (path: string) => unknown }) {
  const link = (path: string, child: Node): Node => ({ type: 'link', url: FILE_HREF + encodeURIComponent(path), children: [child] })
  const splitText = (value: string): Node[] | null => {
    const out: Node[] = []
    let last = 0
    for (const m of value.matchAll(ABS)) {
      const path = m[2].replace(/[.,;:)\]'"]+$/, '')
      if (!options.find(path)) continue
      const start = m.index! + m[1].length
      if (start > last) out.push({ type: 'text', value: value.slice(last, start) })
      out.push(link(path, { type: 'text', value: path }))
      last = start + path.length
    }
    if (!out.length) return null
    if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
    return out
  }
  const walk = (node: Node) => {
    if (!node.children || node.type === 'link' || node.type === 'linkReference') return
    const next: Node[] = []
    for (const child of node.children) {
      if (child.type === 'text' && child.value) {
        const parts = splitText(child.value)
        next.push(...(parts ?? [child]))
      } else if (child.type === 'inlineCode' && child.value && WHOLE.test(child.value) && options.find(child.value)) {
        next.push(link(child.value, child))
      } else {
        walk(child)
        next.push(child)
      }
    }
    node.children = next
  }
  return (tree: Node) => walk(tree)
}
