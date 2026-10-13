// A stand-in for Claude Code's screen in tests: a message box between two rules (with dim ghost text while it's empty)
// that takes typed / pasted keys, and a transcript it writes each sent prompt to as a user entry. It can be slow to
// start (keys typed before it's ready are lost, as with a real session waking up), slow to /clear (the box is gone
// meanwhile), or drop the first prompts sent (they never reach the transcript).
//
//   bun fakeTui.ts --dir <transcripts folder> [--session <id>] [--ready-after ms] [--clear-ms ms] [--compact-ms ms] [--drop n]
//
// The command line for a tmux session: fakeTuiCommand() (agents/testing/tui.ts).

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const dir = arg('dir')
let session = arg('session', crypto.randomUUID())
const readyAfter = Number(arg('ready-after', '0'))
const clearMs = Number(arg('clear-ms', '0'))
const compactMs = Number(arg('compact-ms', '0'))
let drop = Number(arg('drop', '0'))
mkdirSync(dir, { recursive: true })

const RULE = '─'.repeat(60)
let ready = false
let buf = ''
const said: string[] = []

const draw = () => {
  const box = buf ? buf : '\x1b[2mTry "fix the tests"\x1b[0m'
  process.stdout.write(`\x1b[2J\x1b[H${said.map((s) => `⏺ ${s}`).join('\n')}\n${RULE}\n❯ ${box}\n${RULE}\n  ? for shortcuts\n`)
}

const log = (text: string) =>
  appendFileSync(join(dir, `${session}.jsonl`), `${JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: text } })}\n`)

function submit() {
  const text = buf.trim()
  buf = ''
  if (!text) return draw()
  if (text === '/clear') {
    // a new conversation; the screen is blank (and takes no keys) until it's done
    ready = false
    said.length = 0
    process.stdout.write('\x1b[2J\x1b[H')
    setTimeout(() => {
      session = crypto.randomUUID()
      ready = true
      draw()
    }, clearMs)
    return
  }
  if (text.startsWith('/compact')) {
    ready = false
    process.stdout.write('\x1b[2J\x1b[HCompacting conversation…\n')
    setTimeout(() => {
      ready = true
      draw()
    }, compactMs)
    return
  }
  if (drop > 0) drop--
  else {
    log(text)
    said.push(text.split('\n')[0])
  }
  draw()
}

process.stdin.setRawMode?.(true)
process.stdin.on('data', (chunk: Buffer) => {
  // not ready: what's typed goes nowhere
  if (!ready) return
  // a paste comes bracketed (as Claude Code asks for): its line breaks are text, not Enter
  const s = chunk.toString('utf8').replace(/\x1b\[200~([\s\S]*?)\x1b\[201~/g, (_, p: string) => p.replace(/\r\n?/g, '\n'))
  for (const ch of s) {
    if (ch === '\r') submit()
    else if (ch === '\x15') buf = buf.slice(0, buf.lastIndexOf('\n') + 1) // C-u
    else if (ch === '\x05' || ch === '\x1b') continue // C-e, Esc
    else if (ch === '\x7f') buf = buf.slice(0, -1)
    else buf += ch === '\n' ? '\n' : ch
  }
  if (ready) draw()
})

process.stdout.write('\x1b[?2004h\x1b[2J\x1b[HStarting…\n')
setTimeout(() => {
  ready = true
  draw()
}, readyAfter)
