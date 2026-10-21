import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../db'
import { AgentError } from '../agents/errors'

// Pictures in the owner's notes (pasted, dropped or picked in the editor): kept in the data folder, one file each,
// shown from /api/note-images/<file> (signed in only). Only real PNG / JPEG / GIF / WebP, checked by their bytes (never
// SVG: it can carry script).

export const NOTE_IMAGES_DIR = join(DATA_DIR, 'note-images')
export const NOTE_IMAGE_MAX = 10 * 1024 * 1024

const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const
type Ext = keyof typeof TYPES

/** A stored picture's name: its id and its kind, nothing else (no path can sneak in). */
export const NOTE_IMAGE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/
/** Where a note's <img> may point: a stored picture (nothing outside, no data: URIs). */
export const NOTE_IMAGE_SRC = /^\/api\/note-images\/[0-9a-f-]{36}\.(png|jpg|gif|webp)$/

/** What the bytes are (the file's own signature, whatever its name or type says). */
export function imageKind(b: Uint8Array): Ext | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to))
  if (b.length > 8 && b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length > 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'gif'
  if (b.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp'
  return null
}

export function saveNoteImage(data: Uint8Array) {
  if (!data.byteLength) throw new AgentError('The picture is empty', 400)
  if (data.byteLength > NOTE_IMAGE_MAX) throw new AgentError(`A picture is limited to ${NOTE_IMAGE_MAX / 1024 / 1024} MB`, 413)
  const ext = imageKind(data)
  if (!ext) throw new AgentError('Only PNG, JPEG, GIF or WebP pictures', 400)
  mkdirSync(NOTE_IMAGES_DIR, { recursive: true })
  const file = `${crypto.randomUUID()}.${ext}`
  writeFileSync(join(NOTE_IMAGES_DIR, file), data)
  return { url: `/api/note-images/${file}` }
}

/** A stored picture by its name (null: not a valid name, or not there). */
export function noteImageFile(name: string) {
  const m = name.match(NOTE_IMAGE_FILE)
  if (!m) return null
  const path = join(NOTE_IMAGES_DIR, name)
  return existsSync(path) ? { path, type: TYPES[m[1] as Ext] } : null
}

/** A picture's width as the editor keeps it (ui/NoteImageView.tsx safeWidth): 5–100 %, or 24–4000 px. */
export function safeWidth(v: string | undefined) {
  const m = v?.trim().match(/^(\d{1,4}(?:\.\d+)?)(%|px)$/)
  if (!m) return null
  const n = Math.round(Number(m[1]))
  if (m[2] === '%') return n >= 5 && n <= 100 ? `${n}%` : null
  return n >= 24 && n <= 4000 ? `${n}px` : null
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1]
const escAttr = (v: string) => v.replace(/&(?!(amp|lt|gt|quot|#39);)/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * A note's HTML with only its own pictures: any other <img> (outside, data:, tracking pixels) goes, and the ones kept
 * are written again with nothing but their source, words, width and alignment (no other style, no handlers).
 */
export const keepOwnImages = (html: string) =>
  html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = attr(tag, 'src')
    if (!src || !NOTE_IMAGE_SRC.test(src)) return ''
    const width = safeWidth(attr(tag, 'data-width') ?? attr(tag, 'style')?.match(/(?:^|;)\s*width\s*:\s*([^;]+)/i)?.[1])
    const alt = attr(tag, 'alt')
    return `<img src="${src}"${alt ? ` alt="${escAttr(alt)}"` : ''}${width ? ` data-width="${width}" style="width: ${width}"` : ''}${attr(tag, 'data-align') === 'center' ? ' data-align="center"' : ''}>`
  })
