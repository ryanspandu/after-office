import { join } from 'node:path'
import { gateTiming } from '../manager'

/** The command a test's tmux session runs to look like Claude Code at its message box (fakeTui.ts). */
export function fakeTuiCommand(opts: { dir: string; session?: string; readyAfter?: number; clearMs?: number; compactMs?: number; drop?: number }) {
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  const args = [
    process.execPath,
    join(import.meta.dir, 'fakeTui.ts'),
    '--dir',
    opts.dir,
    ...(opts.session ? ['--session', opts.session] : []),
    ...(opts.readyAfter ? ['--ready-after', String(opts.readyAfter)] : []),
    ...(opts.clearMs ? ['--clear-ms', String(opts.clearMs)] : []),
    ...(opts.compactMs ? ['--compact-ms', String(opts.compactMs)] : []),
    ...(opts.drop ? ['--drop', String(opts.drop)] : []),
  ]
  return args.map(q).join(' ')
}

/** Short waits for the input gate, so tests don't sit through real ones. */
export function fastGate() {
  Object.assign(gateTiming, { readyMs: 4_000, pollMs: 50, stableMs: 200, pasteMs: 1_500, minAgeMs: 0, clearMs: 3_000 })
}
