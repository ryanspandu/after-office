import CodeMirror from '@uiw/react-codemirror'
import { vscodeDark, vscodeLight } from '@uiw/codemirror-theme-vscode'
import { keymap } from '@codemirror/view'
import { StreamLanguage } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { yaml } from '@codemirror/lang-yaml'
import { sql } from '@codemirror/lang-sql'
import { php } from '@codemirror/lang-php'
import { xml } from '@codemirror/lang-xml'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { useMemo } from 'react'

// The code editor itself (loaded only when a file is opened: ui/FileEditor.tsx): CodeMirror with VS Code's colours,
// the language picked from the file's name.

/** The language for a file, from its name. Unknown ones are plain text. */
export function languageOf(name: string): { label: string; ext: Extension | null } {
  const base = name.toLowerCase().split('/').pop() ?? ''
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : ''
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return { label: 'Dockerfile', ext: StreamLanguage.define(dockerFile) }
  if (base === '.env' || base.startsWith('.env.') || ['env', 'ini', 'cfg', 'conf', 'properties', 'npmrc', 'editorconfig'].includes(ext))
    return { label: 'Properties', ext: StreamLanguage.define(properties) }
  if (['sh', 'bash', 'zsh'].includes(ext) || ['.bashrc', '.zshrc', '.profile', '.bash_profile'].includes(base)) return { label: 'Shell', ext: StreamLanguage.define(shell) }
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return { label: 'JavaScript', ext: javascript({ jsx: true }) }
    case 'ts':
    case 'mts':
    case 'cts':
      return { label: 'TypeScript', ext: javascript({ typescript: true }) }
    case 'tsx':
      return { label: 'TypeScript (TSX)', ext: javascript({ typescript: true, jsx: true }) }
    case 'json':
    case 'jsonc':
    case 'json5':
      return { label: 'JSON', ext: json() }
    case 'md':
    case 'mdx':
    case 'markdown':
      return { label: 'Markdown', ext: markdown() }
    case 'py':
      return { label: 'Python', ext: python() }
    case 'css':
    case 'scss':
    case 'less':
      return { label: 'CSS', ext: css() }
    case 'html':
    case 'htm':
    case 'vue':
    case 'svelte':
      return { label: 'HTML', ext: html() }
    case 'yml':
    case 'yaml':
      return { label: 'YAML', ext: yaml() }
    case 'sql':
      return { label: 'SQL', ext: sql() }
    case 'php':
      return { label: 'PHP', ext: php() }
    case 'xml':
    case 'svg':
    case 'plist':
      return { label: 'XML', ext: xml() }
    case 'toml':
      return { label: 'TOML', ext: StreamLanguage.define(toml) }
    default:
      return { label: 'Plain text', ext: null }
  }
}

export default function CodeMirrorBox({
  name,
  value,
  onChange,
  onSave,
  readOnly,
  dark,
  focus = true,
}: {
  name: string
  value: string
  onChange: (v: string) => void
  onSave: () => void
  readOnly: boolean
  dark: boolean
  /** the cursor in it when it opens (editing); reading doesn't take the focus */
  focus?: boolean
}) {
  const extensions = useMemo(() => {
    const lang = languageOf(name).ext
    // ⌘S / Ctrl+S saves (instead of the browser's "save page")
    const save = keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => (onSave(), true) }])
    return [save, ...(lang ? [lang] : [])]
    // onSave changes every render: the latest is read through the ref the parent keeps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])
  return (
    <CodeMirror
      className="code-editor__cm"
      value={value}
      onChange={onChange}
      theme={dark ? vscodeDark : vscodeLight}
      extensions={extensions}
      readOnly={readOnly}
      editable={!readOnly}
      height="100%"
      autoFocus={focus}
      basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, bracketMatching: true, closeBrackets: true, autocompletion: true, tabSize: 2 }}
    />
  )
}
