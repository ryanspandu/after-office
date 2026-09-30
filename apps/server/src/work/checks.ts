import { runAsAgent } from '../agents/asagent'

// Quality gate: the owner's check command (tests, lint, build), run in the agent's folder after it finishes a task.
// The command comes from the dashboard (project or task settings), never from an agent.

const TIMEOUT_MS = 10 * 60_000
const KEEP = 4000

export interface CheckResult {
  ok: boolean
  /** the end of stdout + stderr */
  output: string
  timedOut: boolean
  ms: number
}

export async function runCheck(cwd: string, cmd: string, timeoutMs = TIMEOUT_MS): Promise<CheckResult> {
  const started = Date.now()
  try {
    // with the agent's rights, not the dashboard's (agents/asagent.ts)
    const r = await runAsAgent(['sh', '-c', cmd], { cwd, timeoutMs, mergeStderr: true })
    const tail = r.out.length > KEEP ? `…${r.out.slice(-KEEP)}` : r.out
    return {
      ok: r.code === 0,
      output: (r.timedOut ? `${tail.trim()}\n(timed out after ${Math.max(1, Math.round(timeoutMs / 60_000))} min)` : tail).trim(),
      timedOut: r.timedOut,
      ms: Date.now() - started,
    }
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e), timedOut: false, ms: Date.now() - started }
  }
}
