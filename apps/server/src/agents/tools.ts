import { agentsRepo, settingsRepo } from '../db'
import { seal, unseal } from '../totp'
import { AgentError } from './errors'
import { restartWhenIdle } from './reconciler'
import { NAME, RESERVED } from './secrets'

// The office's tools (Tools, ?tools=1): API keys every agent (or the ones picked) may use, set once for the office.
// Image generation: Google AI Studio (Nano Banana, straight from Google), aggregators and other providers (OpenRouter,
// fal.ai, GoAPI, Replicate, OpenAI) and custom ones (any API, its variable named by the owner), each its own key, any
// of them at once. They reach the agents' sessions as the variable each provider's tools read (GEMINI_API_KEY,
// OPENROUTER_API_KEY…), plus AO_IMAGE_PROVIDER (the one to use first) and AO_IMAGE_PROVIDERS (what's set: names,
// variables, models, no keys). Keys are sealed with the server's key and never sent back (the dashboard shows their last
// 4 characters). A change restarts the agents concerned once they're idle, so their sessions get it. The residential
// proxy is a tool too (agents/proxy.ts).

export type ImageProvider = 'google' | 'openrouter' | 'fal' | 'goapi' | 'replicate' | 'openai'

/** Each provider: the variable its key goes in, its API, and its Nano Banana (or best known) image model. */
export const IMAGE_PROVIDERS: Record<ImageProvider, { label: string; env: string; baseUrl: string; model: string }> = {
  google: { label: 'Google AI Studio', env: 'GEMINI_API_KEY', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash-image' },
  openrouter: { label: 'OpenRouter', env: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.5-flash-image' },
  fal: { label: 'fal.ai', env: 'FAL_KEY', baseUrl: 'https://fal.run', model: 'fal-ai/nano-banana' },
  goapi: { label: 'GoAPI', env: 'GOAPI_API_KEY', baseUrl: 'https://api.goapi.ai', model: '' },
  replicate: { label: 'Replicate', env: 'REPLICATE_API_TOKEN', baseUrl: 'https://api.replicate.com/v1', model: 'google/nano-banana' },
  openai: { label: 'ChatGPT (OpenAI)', env: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1' },
}
const BUILT_IN = Object.keys(IMAGE_PROVIDERS) as ImageProvider[]
const isProvider = (v: unknown): v is ImageProvider => typeof v === 'string' && v in IMAGE_PROVIDERS

export interface ImageKeyInfo {
  /** the provider's name for a built-in one, custom-xxxxxx for the owner's own */
  id: string
  provider: ImageProvider | 'custom'
  label: string
  /** the variable agents get the key as */
  env: string
  baseUrl: string
  model: string
  enabled: boolean
  /** the key's last 4 characters, to tell keys apart */
  last4: string
  updatedAt: number
}
export interface ImageToolInfo {
  keys: ImageKeyInfo[]
  /** who gets the keys: every agent, or the ones listed */
  access: 'all' | string[]
  /** the key agents use first (unset: the first one that's on) */
  preferred: string | null
}
interface StoredKey {
  id: string
  provider: ImageProvider | 'custom'
  /** a custom one's own name, variable, API and model (built-in ones take theirs from IMAGE_PROVIDERS) */
  label?: string
  env?: string
  baseUrl?: string
  model?: string
  enabled: boolean
  last4: string
  sealed: string
  updatedAt: number
}
interface Stored {
  keys: StoredKey[]
  access: 'all' | string[]
  preferred: string | null
}

const KEY = 'officeTools:image'
const MAX_KEY = 500
const MAX_CUSTOM = 10

const serverKey = () => {
  const s = process.env.SESSION_SECRET
  if (!s || s.length < 32) throw new AgentError('Sign-in is not set up on this server (SESSION_SECRET)', 500)
  return s
}

function load(): Stored {
  try {
    const v = JSON.parse(settingsRepo.get(KEY) ?? 'null')
    if (v && Array.isArray(v.keys)) {
      // saved before custom keys: the provider was the id
      const keys = (v.keys as StoredKey[]).map((k) => ({ ...k, id: k.id ?? k.provider })).filter((k) => isProvider(k.provider) || (k.provider === 'custom' && k.env))
      return { keys, access: v.access === 'all' || Array.isArray(v.access) ? v.access : 'all', preferred: typeof v.preferred === 'string' ? v.preferred : null }
    }
  } catch {}
  return { keys: [], access: 'all', preferred: null }
}

function save(s: Stored, restart: string[] | 'all') {
  settingsRepo.set(KEY, JSON.stringify(s))
  for (const a of agentsRepo.all()) if (restart === 'all' || restart.includes(a.id)) restartWhenIdle(a.id)
}

/** A key as the dashboard sees it: what it is, never its value. */
function describe(k: StoredKey): ImageKeyInfo {
  const p = isProvider(k.provider) ? IMAGE_PROVIDERS[k.provider] : null
  return {
    id: k.id,
    provider: k.provider,
    label: p?.label ?? k.label ?? 'Custom',
    env: p?.env ?? k.env ?? '',
    baseUrl: p?.baseUrl ?? k.baseUrl ?? '',
    model: k.model || p?.model || '',
    enabled: k.enabled,
    last4: k.last4,
    updatedAt: k.updatedAt,
  }
}

/** Built-in ones first, in their order; custom ones after, oldest first. */
const ordered = (keys: StoredKey[]) => [...BUILT_IN.flatMap((p) => keys.filter((k) => k.id === p)), ...keys.filter((k) => k.provider === 'custom')]
const info = (s: Stored): ImageToolInfo => ({ keys: ordered(s.keys).map(describe), access: s.access, preferred: s.preferred })

/** As the dashboard sees it: no key values. */
export const imageToolInfo = () => info(load())

/** Who the keys reach now: their sessions restart when the keys change. */
const reached = (s: Stored) => (s.access === 'all' ? ('all' as const) : s.access)

const line = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/**
 * Save a key. `id`: a built-in provider's name, an existing custom key's id, or 'custom' for a new custom one. An
 * empty key keeps the saved one (only switched on/off, or a custom one's details changed). Custom: `label`, `env` (the
 * variable agents get it as), and optionally `baseUrl` and `model`; a built-in one may name another `model`.
 */
export function putImageKey(id: unknown, input: { key?: unknown; enabled?: unknown; label?: unknown; env?: unknown; baseUrl?: unknown; model?: unknown }): ImageToolInfo {
  if (typeof id !== 'string' || !id) throw new AgentError('Unknown provider', 400)
  const s = load()
  const isNew = id === 'custom'
  const prev = isNew ? undefined : s.keys.find((k) => k.id === id)
  if (!isNew && !prev && !isProvider(id)) throw new AgentError('Unknown provider', 400)
  const provider: ImageProvider | 'custom' = isProvider(id) ? id : 'custom'
  const key = typeof input.key === 'string' ? input.key.trim() : ''
  if (/[\0\s]/.test(key)) throw new AgentError('The key must be one word, no spaces', 400)
  if (key.length > MAX_KEY) throw new AgentError('That key is too long', 400)
  if (!key && !prev) throw new AgentError('Paste the API key', 400)
  const model = input.model === undefined ? prev?.model : line(input.model, 200) || undefined
  if (model && /[\0\r\n]/.test(model)) throw new AgentError('The model must be one line', 400)
  let custom: Pick<StoredKey, 'label' | 'env' | 'baseUrl'> = {}
  if (provider === 'custom') {
    const label = input.label === undefined ? (prev?.label ?? '') : line(input.label, 60)
    const env = (input.env === undefined ? (prev?.env ?? '') : line(input.env, 64)).toUpperCase()
    const baseUrl = input.baseUrl === undefined ? (prev?.baseUrl ?? '') : line(input.baseUrl, 300)
    if (!label) throw new AgentError('Give it a name', 400)
    if (!NAME.test(env)) throw new AgentError('The variable: capital letters, digits and _ (e.g. MY_IMAGE_API_KEY)', 400)
    if (RESERVED.test(env) || BUILT_IN.some((p) => IMAGE_PROVIDERS[p].env === env)) throw new AgentError(`${env} is the office's own: pick another name`, 400)
    if (s.keys.some((k) => k.id !== prev?.id && k.provider === 'custom' && k.env === env)) throw new AgentError(`Another key already goes in ${env}`, 409)
    if (baseUrl && !/^https?:\/\/[^\s]+$/i.test(baseUrl)) throw new AgentError('The API address: a URL like https://api.example.com', 400)
    if (isNew && s.keys.filter((k) => k.provider === 'custom').length >= MAX_CUSTOM) throw new AgentError(`At most ${MAX_CUSTOM} custom keys`, 409)
    custom = { label, env, ...(baseUrl ? { baseUrl } : {}) }
  }
  const next: StoredKey = {
    id: prev?.id ?? (isNew ? `custom-${crypto.randomUUID().slice(0, 8)}` : id),
    provider,
    ...custom,
    ...(model ? { model } : {}),
    enabled: typeof input.enabled === 'boolean' ? input.enabled : (prev?.enabled ?? true),
    sealed: key ? seal(key, serverKey()) : prev!.sealed,
    last4: key ? key.slice(-4) : prev!.last4,
    updatedAt: Date.now(),
  }
  const out = { ...s, keys: [...s.keys.filter((k) => k.id !== next.id), next] }
  save(out, reached(out))
  return info(out)
}

export function removeImageKey(id: unknown): ImageToolInfo {
  const s = load()
  if (typeof id !== 'string' || !s.keys.some((k) => k.id === id)) return info(s)
  const out = { ...s, keys: s.keys.filter((k) => k.id !== id), preferred: s.preferred === id ? null : s.preferred }
  save(out, reached(out))
  return info(out)
}

/** Who gets the keys, and which key comes first. */
export function setImageAccess(input: { access?: unknown; preferred?: unknown }): ImageToolInfo {
  const s = load()
  let access = s.access
  if (input.access === 'all') access = 'all'
  else if (Array.isArray(input.access)) access = [...new Set(input.access.filter((x): x is string => typeof x === 'string' && !!agentsRepo.get(x)))]
  const preferred = input.preferred === null ? null : typeof input.preferred === 'string' && s.keys.some((k) => k.id === input.preferred) ? input.preferred : s.preferred
  const out = { ...s, access, preferred }
  // the ones that had it and the ones that get it now
  const before = reached(s)
  const after = reached(out)
  save(out, before === 'all' || after === 'all' ? 'all' : [...new Set([...before, ...after])])
  return info(out)
}

/** For an agent's sessions: the keys that are on (when it may have them), which one first, and what each one is. */
export function toolsEnv(agentId: string): Record<string, string> {
  const s = load()
  if (s.access !== 'all' && !s.access.includes(agentId)) return {}
  const secret = process.env.SESSION_SECRET
  if (!secret) return {}
  const env: Record<string, string> = {}
  const on: ImageKeyInfo[] = []
  for (const k of ordered(s.keys)) {
    if (!k.enabled) continue
    const value = unseal(k.sealed, secret)
    if (!value) continue
    const d = describe(k)
    env[d.env] = value
    on.push(d)
  }
  if (!on.length) return env
  env.AO_IMAGE_PROVIDER = (on.find((k) => k.id === s.preferred) ?? on[0]).id
  env.AO_IMAGE_PROVIDERS = JSON.stringify(on.map(({ id, label, env, baseUrl, model }) => ({ id, label, env, ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}) })))
  return env
}

export interface KeyTest {
  ok: boolean
  /** what the provider said about it (models it has, credit left…) */
  detail?: string
  ms?: number
  error?: string
}

/** One cheap request with the saved key (no image is made): is it accepted? */
export async function testImageKey(id: unknown): Promise<KeyTest> {
  const saved = load().keys.find((x) => x.id === id)
  if (!saved) throw new AgentError('Save a key first', 400)
  const key = unseal(saved.sealed, serverKey())
  if (!key) throw new AgentError('The saved key could not be read: paste it again', 400)
  const started = Date.now()
  const get = (url: string, headers: Record<string, string>) => fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
  const ms = () => Date.now() - started
  try {
    switch (saved.provider) {
      case 'google': {
        const r = await get('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { 'x-goog-api-key': key })
        if (!r.ok) return { ok: false, ms: ms(), error: await reason(r) }
        const j = (await r.json()) as { models?: { name?: string }[] }
        const images = (j.models ?? []).map((m) => (m.name ?? '').replace(/^models\//, '')).filter((n) => /image/i.test(n))
        return { ok: true, ms: ms(), detail: images.length ? `Image models: ${images.slice(0, 4).join(', ')}` : 'Key works, but no image model is listed for it' }
      }
      case 'openrouter': {
        const r = await get('https://openrouter.ai/api/v1/key', { authorization: `Bearer ${key}` })
        if (!r.ok) return { ok: false, ms: ms(), error: await reason(r) }
        const d = ((await r.json()) as { data?: { usage?: number; limit?: number | null } }).data
        return { ok: true, ms: ms(), detail: d ? `Used $${(d.usage ?? 0).toFixed(2)}${d.limit != null ? ` of $${d.limit.toFixed(2)}` : ''}` : undefined }
      }
      case 'openai': {
        const r = await get('https://api.openai.com/v1/models', { authorization: `Bearer ${key}` })
        if (!r.ok) return { ok: false, ms: ms(), error: await reason(r) }
        const j = (await r.json()) as { data?: { id?: string }[] }
        const images = (j.data ?? []).map((m) => m.id ?? '').filter((n) => /image|dall-e/i.test(n))
        return { ok: true, ms: ms(), detail: images.length ? `Image models: ${images.slice(0, 4).join(', ')}` : undefined }
      }
      case 'replicate': {
        const r = await get('https://api.replicate.com/v1/account', { authorization: `Bearer ${key}` })
        if (!r.ok) return { ok: false, ms: ms(), error: await reason(r) }
        const j = (await r.json()) as { username?: string }
        return { ok: true, ms: ms(), detail: j.username ? `Account: ${j.username}` : undefined }
      }
      case 'fal': {
        const r = await get('https://api.fal.ai/v1/models?limit=1', { authorization: `Key ${key}` })
        if (r.status === 401 || r.status === 403) return { ok: false, ms: ms(), error: await reason(r) }
        return r.ok ? { ok: true, ms: ms() } : { ok: true, ms: ms(), detail: `fal.ai answered ${r.status}: the key couldn't be fully checked without making an image` }
      }
      default:
        // GoAPI and custom APIs have no common way to check a key without making an image
        return { ok: true, ms: 0, detail: "Saved. This one can't be checked without making an image: ask an agent for a small test image." }
    }
  } catch (e) {
    return { ok: false, ms: ms(), error: e instanceof Error ? e.message.slice(0, 200) : 'No answer' }
  }
}

async function reason(r: Response) {
  const t = await r.text().catch(() => '')
  const refused = r.status === 401 || r.status === 403
  try {
    const j = JSON.parse(t) as { error?: { message?: string } | string; message?: string; detail?: string }
    const m = typeof j.error === 'string' ? j.error : (j.error?.message ?? j.message ?? j.detail)
    if (m) return refused ? `The key was refused (${r.status}: ${String(m).slice(0, 160)})` : `${r.status}: ${String(m).slice(0, 200)}`
  } catch {}
  return refused ? `The key was refused (${r.status})` : `${r.status}: ${r.statusText || 'request failed'}`
}
