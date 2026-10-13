import { useEffect, useState } from 'react'
import ReactSelect from 'react-select'
import { LuCircleCheck, LuCircleX, LuImage, LuKeyRound, LuLoader, LuPencil, LuPlus, LuTrash2 } from 'react-icons/lu'
import { api } from '../state/auth'
import { useOffice } from '../state/store'
import { confirm } from './Confirm'
import { Modal } from './Modal'
import { ProxySection } from './ProxySettings'
import { Select } from './Select'

// Tools (?tools=1, from the Profile): what the office gives its agents to work with, set once for everyone. Image
// generation (API keys: Google AI Studio for Nano Banana, aggregators and other providers, or a custom API) and the
// residential proxy. Keys are saved on the server and never shown again (their last 4 characters tell them apart);
// server: agents/tools.ts.

type Provider = 'google' | 'openrouter' | 'fal' | 'goapi' | 'replicate' | 'openai' | 'custom'
interface ImageKey {
  id: string
  provider: Provider
  label: string
  env: string
  baseUrl: string
  model: string
  enabled: boolean
  last4: string
  updatedAt: number
}
interface ImageTool {
  keys: ImageKey[]
  access: 'all' | string[]
  preferred: string | null
}
interface KeyTest {
  ok: boolean
  detail?: string
  ms?: number
  error?: string
}

/** Each provider: where its key comes from, what agents get it as, and its usual image model. */
const PROVIDERS: { value: Provider; label: string; env: string; model: string; hint: string; url?: string }[] = [
  { value: 'google', label: 'Google AI Studio', env: 'GEMINI_API_KEY', model: 'gemini-2.5-flash-image', hint: 'Nano Banana straight from Google. Image models need billing on the key’s project.', url: 'https://aistudio.google.com/apikey' },
  { value: 'openrouter', label: 'OpenRouter', env: 'OPENROUTER_API_KEY', model: 'google/gemini-2.5-flash-image', hint: 'One key for many models (Nano Banana, FLUX, GPT image…), paid from OpenRouter credit.', url: 'https://openrouter.ai/settings/keys' },
  { value: 'fal', label: 'fal.ai', env: 'FAL_KEY', model: 'fal-ai/nano-banana', hint: 'Many image models (Nano Banana, FLUX, Seedream…), paid per image.', url: 'https://fal.ai/dashboard/keys' },
  { value: 'goapi', label: 'GoAPI', env: 'GOAPI_API_KEY', model: '', hint: 'Midjourney, Flux and other image models behind one API, paid per task.', url: 'https://goapi.ai/dashboard' },
  { value: 'replicate', label: 'Replicate', env: 'REPLICATE_API_TOKEN', model: 'google/nano-banana', hint: 'Thousands of open and hosted models (Nano Banana, FLUX, SDXL…), paid per run.', url: 'https://replicate.com/account/api-tokens' },
  { value: 'openai', label: 'ChatGPT (OpenAI)', env: 'OPENAI_API_KEY', model: 'gpt-image-1', hint: 'ChatGPT’s image model through the OpenAI API (a ChatGPT subscription doesn’t include it).', url: 'https://platform.openai.com/api-keys' },
  { value: 'custom', label: 'Custom', env: '', model: '', hint: 'Any other image API: name it, pick the variable agents get the key as, and give its address so they can read its docs.' },
]
const providerOf = (v: Provider) => PROVIDERS.find((p) => p.value === v)!

async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
  const j = await res.json().catch(() => null)
  if (!res.ok) throw new Error(j?.error ?? `Request failed (${res.status})`)
  return j as T
}

export function ToolsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="Tools" description="What the office gives its agents to work with: set once, used by every agent (or the ones you pick)." width={560}>
      <div className="modal__body tools">
        <ImageSection />
        <section className="tools__section">
          <h4 className="tools__title">Residential proxy</h4>
          <ProxySection />
        </section>
      </div>
    </Modal>
  )
}

function TestLine({ t }: { t: KeyTest }) {
  return t.ok ? (
    <p className="proxy__test proxy__test--ok">
      <LuCircleCheck /> {t.detail && !t.ms ? t.detail : `Key works${t.detail ? `: ${t.detail}` : ''}`}
      {!!t.ms && <span className="muted"> · {(t.ms / 1000).toFixed(1)} s</span>}
    </p>
  ) : (
    <p className="proxy__test proxy__test--bad">
      <LuCircleX /> {t.error ?? 'It was refused'}
    </p>
  )
}

function ImageSection() {
  const [tool, setTool] = useState<ImageTool | null>(null)
  // the key being added ('new') or changed (its id)
  const [editing, setEditing] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, KeyTest | undefined>>({})
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const agents = useOffice((s) => s.agents)
  useEffect(() => {
    void call<ImageTool>('/api/tools/image').then(setTool, (e: Error) => setError(e.message))
  }, [])

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy('')
    }
  }
  const test = (id: string) =>
    run(`test:${id}`, async () => {
      setTests((t) => ({ ...t, [id]: undefined }))
      const r = await call<KeyTest>(`/api/tools/image/${id}/test`, 'POST')
      setTests((t) => ({ ...t, [id]: r }))
    })
  const toggle = (id: string, on: boolean) => run(`toggle:${id}`, async () => setTool(await call<ImageTool>(`/api/tools/image/${id}`, 'PUT', { enabled: on })))
  const remove = (k: ImageKey) =>
    run(`remove:${k.id}`, async () => {
      if (!(await confirm({ title: `Remove the ${k.label} key?`, message: `Agents lose ${k.env} once they restart (when idle).`, confirmLabel: 'Remove', danger: true }))) return
      setTool(await call<ImageTool>(`/api/tools/image/${k.id}`, 'DELETE'))
      setTests((t) => ({ ...t, [k.id]: undefined }))
    })
  const setAccess = (body: { access?: 'all' | string[]; preferred?: string | null }) => run('access', async () => setTool(await call<ImageTool>('/api/tools/image', 'PUT', body)))

  const saved = tool?.keys ?? []
  const on = saved.filter((k) => k.enabled)
  const options = agents.map((a) => ({ value: a.id, label: a.name }))

  return (
    <section className="tools__section">
      <h4 className="tools__title">
        <LuImage /> Image generation
      </h4>
      {!tool ? (
        error ? null : (
          <span className="field__hint">
            <LuLoader className="spin" /> Loading…
          </span>
        )
      ) : (
        <>
          {saved.map((k) => (
            <div key={k.id} className="tools__item">
              <div className="proxy__summary">
                <LuKeyRound />
                <span className="proxy__what">
                  <b>{k.label}</b>
                  <span className="mono muted">
                    {k.env} · ••••{k.last4}
                    {k.model ? ` · ${k.model}` : ''}
                  </span>
                </span>
                <label className="toggle" data-tip={k.enabled ? 'On: agents get it' : 'Off: agents don’t get it'}>
                  <input type="checkbox" role="switch" aria-label={`Use ${k.label}`} checked={k.enabled} disabled={!!busy} onChange={(e) => void toggle(k.id, e.target.checked)} />
                  <span />
                </label>
              </div>
              <div className="project-settings__move-actions">
                <button type="button" className="small" onClick={() => setEditing(k.id)}>
                  <LuPencil /> Edit
                </button>
                <button type="button" className="small" disabled={!!busy} onClick={() => void test(k.id)}>
                  {busy === `test:${k.id}` ? <LuLoader className="spin" /> : <LuCircleCheck />} Test
                </button>
                <button type="button" className="small ghost" disabled={!!busy} onClick={() => void remove(k)}>
                  <LuTrash2 /> Remove
                </button>
              </div>
              {tests[k.id] && <TestLine t={tests[k.id]!} />}
            </div>
          ))}
          <div className="project-settings__move-actions">
            <button type="button" className="small" onClick={() => setEditing('new')}>
              <LuPlus /> Add API key
            </button>
          </div>
          {saved.length > 0 && (
            <div className="tools__access">
              {on.length > 1 && (
                <label className="field">
                  <span className="field__label">Use first</span>
                  <Select
                    ariaLabel="Key agents use first"
                    value={tool.preferred && on.some((k) => k.id === tool.preferred) ? tool.preferred : on[0].id}
                    options={on.map((k) => ({ value: k.id, label: k.label }))}
                    onChange={(v) => void setAccess({ preferred: v })}
                  />
                </label>
              )}
              <div className="field">
                <span className="field__label">Who can use it</span>
                <div className="seg tools__seg">
                  <button type="button" className={tool.access === 'all' ? 'active' : ''} disabled={!!busy} onClick={() => void setAccess({ access: 'all' })}>
                    Every agent
                  </button>
                  <button type="button" className={tool.access !== 'all' ? 'active' : ''} disabled={!!busy} onClick={() => tool.access === 'all' && void setAccess({ access: [] })}>
                    Only these
                  </button>
                </div>
                {tool.access !== 'all' && (
                  <ReactSelect<(typeof options)[number], true>
                    unstyled
                    isMulti
                    isClearable={false}
                    placeholder="Pick agents…"
                    noOptionsMessage={() => 'No agents'}
                    aria-label="Agents that can use it"
                    className="rs rs--md rs--multi"
                    classNamePrefix="rs"
                    value={options.filter((o) => (tool.access as string[]).includes(o.value))}
                    options={options}
                    onChange={(list) => void setAccess({ access: list.map((o) => o.value) })}
                    menuPortalTarget={document.body}
                    menuPlacement="auto"
                  />
                )}
              </div>
            </div>
          )}
        </>
      )}
      {error && <p className="danger-text">{error}</p>}
      <span className="field__hint">
        Agents get each key as its variable, and the one to use first as <span className="mono">AO_IMAGE_PROVIDER</span>; they make images only when asked (each one is paid). A change reaches them when they’re next idle.
      </span>
      {editing && (
        <KeyModal
          saved={editing === 'new' ? null : (saved.find((k) => k.id === editing) ?? null)}
          taken={saved.filter((k) => k.provider !== 'custom').map((k) => k.provider)}
          onClose={() => setEditing(null)}
          onSaved={(t, id, test) => {
            setTool(t)
            setTests((x) => ({ ...x, [id]: test ?? undefined }))
            setEditing(null)
          }}
        />
      )}
    </section>
  )
}

/** Add a key (pick its provider first) or change one: the key, the model, a custom one's details. */
function KeyModal({ saved, taken, onClose, onSaved }: { saved: ImageKey | null; taken: Provider[]; onClose: () => void; onSaved: (t: ImageTool, id: string, test: KeyTest | null) => void }) {
  // a provider already set is changed from its own card, not added twice (custom ones: as many as needed)
  const choices = PROVIDERS.filter((p) => p.value === 'custom' || !taken.includes(p.value))
  const [provider, setProvider] = useState<Provider>(saved?.provider ?? choices[0].value)
  const [key, setKey] = useState('')
  const [model, setModel] = useState(saved && saved.model !== providerOf(saved.provider).model ? saved.model : '')
  const [label, setLabel] = useState(saved?.provider === 'custom' ? saved.label : '')
  const [env, setEnv] = useState(saved?.provider === 'custom' ? saved.env : '')
  const [baseUrl, setBaseUrl] = useState(saved?.provider === 'custom' ? saved.baseUrl : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const p = providerOf(provider)
  const custom = provider === 'custom'
  // a custom one's variable follows its name until it's typed in
  const [envTyped, setEnvTyped] = useState(!!saved)
  const nameToEnv = (n: string) => `${n.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}_API_KEY`.replace(/^_API_KEY$/, '')

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const id = saved?.id ?? provider
      const t = await call<ImageTool>(`/api/tools/image/${id}`, 'PUT', {
        ...(key.trim() ? { key: key.trim() } : {}),
        model: model.trim(),
        ...(custom ? { label: label.trim(), env: env.trim(), baseUrl: baseUrl.trim() } : {}),
      })
      // a new custom one: the server named it
      const savedId = saved?.id ?? (custom ? (t.keys.filter((k) => k.provider === 'custom').sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? id) : id)
      const test = key.trim() ? await call<KeyTest>(`/api/tools/image/${savedId}/test`, 'POST').catch((e: Error) => ({ ok: false, error: e.message })) : null
      onSaved(t, savedId, test)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={saved ? saved.label : 'Add API key'} description="Saved on the server; the key is never shown again." width={460}>
      <form
        className="modal__body proxy-form"
        onSubmit={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void save()
        }}
      >
        {!saved && (
          <div className="field">
            <span className="field__label">Provider</span>
            <Select ariaLabel="Provider" value={provider} options={choices.map(({ value, label }) => ({ value, label }))} onChange={(v) => setProvider(v)} />
          </div>
        )}
        {custom && (
          <>
            <label className="field">
              <span className="field__label">Name</span>
              <input
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value)
                  if (!envTyped) setEnv(nameToEnv(e.target.value))
                }}
                placeholder="e.g. Ideogram"
                maxLength={60}
                required
              />
            </label>
            <label className="field">
              <span className="field__label">Variable</span>
              <input
                value={env}
                onChange={(e) => {
                  setEnvTyped(true)
                  setEnv(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))
                }}
                className="mono"
                placeholder="IDEOGRAM_API_KEY"
                maxLength={64}
                required
              />
              <span className="field__hint">What agents get the key as.</span>
            </label>
            <label className="field">
              <span className="field__label">API address (optional)</span>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="mono" placeholder="https://api.example.com" spellCheck={false} />
            </label>
          </>
        )}
        <label className="field">
          <span className="field__label">API key</span>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoComplete="new-password"
            spellCheck={false}
            className="mono"
            placeholder={saved ? `Saved (••••${saved.last4}): leave empty to keep it` : 'Paste the key'}
            autoFocus={!custom}
            required={!saved}
          />
          <span className="field__hint">
            {p.hint}
            {p.url && (
              <>
                {' '}
                <a href={p.url} target="_blank" rel="noreferrer">
                  Get a key
                </a>
                .
              </>
            )}
            {p.env && (
              <>
                {' '}
                Agents get it as <span className="mono">{p.env}</span>.
              </>
            )}
          </span>
        </label>
        <label className="field">
          <span className="field__label">Model (optional)</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} className="mono" placeholder={p.model || 'the provider’s model id'} spellCheck={false} maxLength={200} />
          <span className="field__hint">{p.model ? `Empty: ${p.model}.` : 'Which model agents use, if you have one in mind.'} A model you name in a task wins.</span>
        </label>
        {error && <p className="danger-text">{error}</p>}
        <footer className="modal__foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || (!saved && !key.trim()) || (custom && (!label.trim() || !env.trim()))}>
            {busy ? 'Saving…' : key.trim() ? 'Save & test' : 'Save'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
