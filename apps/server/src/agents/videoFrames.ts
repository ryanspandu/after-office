import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { extname, join } from 'node:path'

// A video attached in a chat: Claude Code can't watch one, but it reads pictures. So the server lays its frames out on
// a few contact sheets (ffmpeg): one frame every few seconds, 12 to a sheet (4 across, 3 down, read left to right, top
// to bottom), at most 60 frames. Each sheet's name says which part of the video it covers and how far apart its frames
// are, so the agent reading "sheet-2_00m24s-00m48s_every-2s.jpg" knows what it's looking at. No ffmpeg on the server:
// no sheets (the video is still attached; the office rules tell the agent it may use ffmpeg itself).

export const VIDEO = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mpeg', '.mpg', '.3gp'])
export const isVideo = (name: string) => VIDEO.has(extname(name).toLowerCase())

/** Frames in all, frames on a sheet, and the shortest gap between frames (s). */
export const SHEET = { maxFrames: 60, perSheet: 12, cols: 4, rows: 3, minEvery: 2, width: 320 }
/** Longest the server spends on one video's sheets. */
const TIMEOUT_MS = 120_000

const bin = (name: string) => process.env[`OFFICE_${name.toUpperCase()}`] || Bun.which(name)

/** How a video of `duration` seconds is laid out: a frame every `every` s, `frames` of them on `sheets` sheets. */
export function sheetPlan(duration: number) {
  const every = Math.max(SHEET.minEvery, Math.ceil(duration / SHEET.maxFrames))
  const frames = Math.max(1, Math.min(SHEET.maxFrames, Math.ceil(duration / every)))
  return { every, frames, sheets: Math.ceil(frames / SHEET.perSheet) }
}

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}m${String(Math.floor(s % 60)).padStart(2, '0')}s`
/** "sheet-2_00m24s-00m48s_every-2s.jpg" */
export const sheetName = (n: number, every: number, duration: number) => {
  const from = (n - 1) * SHEET.perSheet * every
  const to = Math.min(duration, n * SHEET.perSheet * every)
  return `sheet-${n}_${mmss(from)}-${mmss(to)}_every-${every}s.jpg`
}

async function run(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => p.kill(), TIMEOUT_MS)
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  clearTimeout(timer)
  return { out: out.trim(), ok: code === 0 }
}

/** The contact sheets of `video`, written into `dir` (made if needed); their file names, or [] when there's no ffmpeg
 *  or the video can't be read. */
export async function makeContactSheets(video: string, dir: string): Promise<string[]> {
  const ffmpeg = bin('ffmpeg')
  const ffprobe = bin('ffprobe')
  if (!ffmpeg || !ffprobe) {
    console.warn('[uploads] no ffmpeg/ffprobe on this server: videos are attached without frame sheets')
    return []
  }
  const probe = await run([ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video])
  const duration = Number(probe.out)
  if (!probe.ok || !Number.isFinite(duration) || duration <= 0) return []
  const plan = sheetPlan(duration)
  mkdirSync(dir, { recursive: true })
  const made = await run([
    ffmpeg,
    '-v',
    'error',
    '-nostdin',
    '-i',
    video,
    '-vf',
    `fps=1/${plan.every},scale=${SHEET.width}:-2,tile=${SHEET.cols}x${SHEET.rows}`,
    '-frames:v',
    String(plan.sheets),
    '-q:v',
    '4',
    join(dir, 'sheet-%d.jpg'),
  ])
  if (!made.ok) return []
  // named by what they cover
  const names: string[] = []
  for (let n = 1; n <= plan.sheets; n++) {
    const from = join(dir, `sheet-${n}.jpg`)
    if (!existsSync(from)) break
    const name = sheetName(n, plan.every, duration)
    renameSync(from, join(dir, name))
    names.push(name)
  }
  return names
}

/** The sheets already made for a staged video (its frames/ folder), in order. */
export function stagedSheets(dir: string) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => /^sheet-\d+_.*\.jpg$/.test(f))
    .sort((a, b) => Number(a.match(/^sheet-(\d+)/)![1]) - Number(b.match(/^sheet-(\d+)/)![1]))
}
