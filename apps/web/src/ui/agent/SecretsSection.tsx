import { useCallback, useEffect, useState } from 'react'
import { LuCheck, LuExternalLink, LuKeyRound, LuPencil, LuPlus, LuTrash2, LuX } from 'react-icons/lu'
import { liveApi } from '../../state/live'
import type { OfficeAgent } from '../../state/store'
import { confirm } from '../Confirm'
import { Select } from '../Select'
import { tip } from '../Tooltip'
import { setUrl, useParam } from '../../state/url'

/** The command-line tool a token signs in (the Server window → Tools lists them too). */
const SIGNS_IN: Record<string, string> = {
  EXPO_TOKEN: 'eas',
  RAILWAY_TOKEN: 'railway',
  RAILWAY_API_TOKEN: 'railway',
  SUPABASE_ACCESS_TOKEN: 'supabase',
  VERCEL_TOKEN: 'vercel',
  GH_TOKEN: 'gh',
  GITHUB_TOKEN: 'gh',
  GITLAB_TOKEN: 'glab',
  CLOUDFLARE_API_TOKEN: 'wrangler',
  NETLIFY_AUTH_TOKEN: 'netlify',
  NPM_TOKEN: 'npm',
  FLY_API_TOKEN: 'fly',
  RENDER_API_KEY: 'render',
  SENTRY_AUTH_TOKEN: 'sentry-cli',
  FIREBASE_TOKEN: 'firebase',
  SHOPIFY_CLI_PARTNERS_TOKEN: 'shopify',
  STRIPE_API_KEY: 'stripe',
}

// Overview → Secrets: tokens for the services this agent's projects use (Expo, Railway, Supabase…), given to its
// sessions as environment variables that those tools read on their own. Pick the service, paste the token, done.
// Write-only: only the name and the last 4 characters come back. A change restarts the agent once it's idle.

interface Preset {
  id: string
  label: string
  name: string
  /** where to make one */
  url?: string
}
const PRESETS: Preset[] = [
  { id: 'expo', label: 'Expo (EAS)', name: 'EXPO_TOKEN', url: 'https://expo.dev/accounts/[account]/settings/access-tokens' },
  { id: 'railway', label: 'Railway', name: 'RAILWAY_TOKEN', url: 'https://railway.com/account/tokens' },
  { id: 'supabase', label: 'Supabase', name: 'SUPABASE_ACCESS_TOKEN', url: 'https://supabase.com/dashboard/account/tokens' },
  { id: 'vercel', label: 'Vercel', name: 'VERCEL_TOKEN', url: 'https://vercel.com/account/tokens' },
  { id: 'github', label: 'GitHub (gh CLI)', name: 'GH_TOKEN', url: 'https://github.com/settings/tokens' },
  { id: 'gitlab', label: 'GitLab (glab CLI)', name: 'GITLAB_TOKEN', url: 'https://gitlab.com/-/user_settings/personal_access_tokens' },
  // no official CLI: the name scripts and tools commonly read (an API token from Bitbucket's account settings)
  { id: 'bitbucket', label: 'Bitbucket', name: 'BITBUCKET_TOKEN', url: 'https://bitbucket.org/account/settings/api-tokens/' },
  { id: 'cloudflare', label: 'Cloudflare', name: 'CLOUDFLARE_API_TOKEN', url: 'https://dash.cloudflare.com/profile/api-tokens' },
  { id: 'netlify', label: 'Netlify', name: 'NETLIFY_AUTH_TOKEN', url: 'https://app.netlify.com/user/applications#personal-access-tokens' },
  { id: 'npm', label: 'npm', name: 'NPM_TOKEN', url: 'https://www.npmjs.com/settings/~/tokens' },
  { id: 'fly', label: 'Fly.io', name: 'FLY_API_TOKEN', url: 'https://fly.io/user/personal_access_tokens' },
  { id: 'render', label: 'Render', name: 'RENDER_API_KEY', url: 'https://dashboard.render.com/u/settings#api-keys' },
  { id: 'sentry', label: 'Sentry', name: 'SENTRY_AUTH_TOKEN', url: 'https://sentry.io/settings/account/api/auth-tokens/' },
  { id: 'firebase', label: 'Firebase', name: 'FIREBASE_TOKEN' },
  { id: 'other', label: 'Other (any name)', name: '' },
]

type Secret = { name: string; last4: string; updatedAt: number }

export function SecretsSection({ agent }: { agent: OfficeAgent }) {
  const [list, setList] = useState<Secret[] | null>(null)
  const [adding, setAdding] = useState<{ preset: string; name: string; value: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(() => void liveApi.secrets(agent.id).then(setList), [agent.id])
  useEffect(load, [load])
  // sent here from the Server window's "Token" (?secret=EXPO_TOKEN): that one, ready to paste
  const asked = useParam('secret')
  useEffect(() => {
    if (!asked) return
    start(asked)
    setUrl({ secret: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked])

  const preset = PRESETS.find((p) => p.id === adding?.preset)
  const start = (name = '') => {
    setError('')
    const known = PRESETS.find((p) => p.name && p.name === name)
    setAdding({ preset: known?.id ?? (name ? 'other' : 'expo'), name: name || PRESETS[0].name, value: '' })
  }
  const save = async () => {
    if (!adding) return
    setBusy(true)
    setError('')
    try {
      await liveApi.putSecret(agent.id, adding.name, adding.value)
      setAdding(null)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save it')
    } finally {
      setBusy(false)
    }
  }
  const remove = async (s: Secret) => {
    if (!(await confirm({ title: `Remove ${s.name}?`, message: `${agent.name} won't have it any more (it restarts once it's idle).`, confirmLabel: 'Remove' }))) return
    await liveApi.removeSecret(agent.id, s.name).catch((e) => setError(e.message))
    load()
  }

  return (
    <section className="git-section secrets">
      <h4 className="git-section__title">
        <LuKeyRound /> Secrets
      </h4>
      <p className="field__hint secrets__hint">
        Tokens for the services its projects use (Expo, Railway, Supabase…). They're environment variables of {agent.name}'s session, and the tools read them on
        their own. Write-only: you see the name and the last 4 characters.
      </p>
      {list && list.length > 0 && (
        <ul className="secrets__list">
          {list.map((s) => (
            <li key={s.name} className="secrets__row">
              <code className="secrets__name">{s.name}</code>
              <span className="muted secrets__value">•••• {s.last4}</span>
              {SIGNS_IN[s.name] && <span className="muted secrets__tools">signs in {SIGNS_IN[s.name]}</span>}
              <span className="grow" />
              <button className="icon-btn small ghost" onClick={() => start(s.name)} {...tip('Replace the value')} aria-label={`Replace ${s.name}`}>
                <LuPencil />
              </button>
              <button className="icon-btn small ghost" onClick={() => void remove(s)} {...tip('Remove')} aria-label={`Remove ${s.name}`}>
                <LuTrash2 />
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <form
          className="secrets__form ui-drop"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="field-row">
            <label className="field">
              <span className="field__label">Service</span>
              <Select
                ariaLabel="Service"
                searchable
                value={adding.preset}
                options={PRESETS.map((p) => ({ value: p.id, label: p.name ? `${p.label} · ${p.name}` : p.label }))}
                onChange={(id) => setAdding((a) => a && { ...a, preset: id, name: PRESETS.find((p) => p.id === id)?.name || (a.preset === 'other' ? a.name : '') })}
              />
            </label>
            <label className="field">
              <span className="field__label">Variable name</span>
              <input
                value={adding.name}
                onChange={(e) => setAdding((a) => a && { ...a, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })}
                readOnly={adding.preset !== 'other'}
                placeholder="MY_SERVICE_TOKEN"
                className="mono"
                maxLength={64}
              />
            </label>
          </div>
          <label className="field">
            <span className="field__label">Value</span>
            <input type="password" value={adding.value} onChange={(e) => setAdding((a) => a && { ...a, value: e.target.value })} placeholder="Paste the token" autoComplete="off" autoFocus />
            {preset?.url && (
              <a className="field__hint secrets__get" href={preset.url} target="_blank" rel="noreferrer">
                Create one on {preset.label} <LuExternalLink />
              </a>
            )}
          </label>
          {error && <p className="danger-text">{error}</p>}
          <div className="git-section__row">
            <span className="grow" />
            <button type="button" className="small" onClick={() => setAdding(null)}>
              <LuX /> Cancel
            </button>
            <button type="submit" className="small primary" disabled={busy || !adding.name || !adding.value.trim()}>
              <LuCheck /> {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      ) : (
        <>
          {error && <p className="danger-text">{error}</p>}
          <button className="small git-section__add" onClick={() => start()}>
            <LuPlus /> Add a secret
          </button>
        </>
      )}
    </section>
  )
}
