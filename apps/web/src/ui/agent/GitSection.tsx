import { useEffect, useRef, useState } from 'react'
import { LuCheck, LuCopy, LuGitBranch, LuKeyRound, LuPlus, LuTrash2, LuUpload, LuWandSparkles } from 'react-icons/lu'
import type { GitIdentity } from '@after-office/shared'
import { liveApi } from '../../state/live'
import type { OfficeAgent } from '../../state/store'
import { confirm } from '../Confirm'
import { Field } from '../Modal'
import { tip } from '../Tooltip'

// An agent's git identities (its Overview): a default one, and extra ones for the projects their rules match (a
// folder, or repos by remote such as github.com/acme), each with its own name, email and SSH key. The agent's session
// uses a gitconfig of its own, so changes apply at once (a session started before it had one restarts once idle).
// Only public keys are ever shown; private ones stay on the server.

/** "Marcus" → "marcus", for example email addresses */
const handle = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'agent'

type Busy = '' | 'save' | 'gen' | 'upload' | 'remove' | 'delete'

async function attempt(setBusy: (b: Busy) => void, setError: (e: string) => void, what: Busy, fn: () => Promise<unknown>) {
  setBusy(what)
  setError('')
  try {
    await fn()
    return true
  } catch (e) {
    setError(e instanceof Error ? e.message : 'Failed')
    return false
  } finally {
    setBusy('')
  }
}

/** An identity's SSH key: shown (public half), generated, uploaded or removed. */
function KeyBox({ agent, sshKey, identity, label }: { agent: OfficeAgent; sshKey?: { publicKey: string; fingerprint: string }; identity?: string; label: string }) {
  const [busy, setBusy] = useState<Busy>('')
  const [error, setError] = useState('')
  const [pasting, setPasting] = useState(false)
  const [privateKey, setPrivateKey] = useState('')
  const [copied, setCopied] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const run = (what: Busy, fn: () => Promise<unknown>) => attempt(setBusy, setError, what, fn)

  const generate = async () => {
    if (sshKey && !(await confirm({ title: `Replace the SSH key of ${label}?`, message: 'The old key stops working: remove it where you added it (GitHub, servers).', confirmLabel: 'Make a new key' }))) return
    await run('gen', () => liveApi.generateSshKey(agent.id, identity))
  }
  const upload = async () => {
    if (await run('upload', () => liveApi.uploadSshKey(agent.id, privateKey, identity))) {
      setPrivateKey('')
      setPasting(false)
    }
  }
  const remove = async () => {
    if (!(await confirm({ title: `Remove the SSH key of ${label}?`, message: 'Git over SSH stops working for it until it gets another key. Also remove it where you added it.', confirmLabel: 'Remove key' }))) return
    await run('remove', () => liveApi.removeSshKey(agent.id, identity))
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sshKey!.publicKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setError('Copy failed: select the key and copy it yourself.')
    }
  }

  return (
    <div className="field">
      <span className="field__label">SSH key</span>
      {sshKey ? (
        <div className="ssh-key">
          <div className="ssh-key__head">
            <LuKeyRound />
            <span className="mono truncate" data-tip="Fingerprint">
              {sshKey.fingerprint}
            </span>
            <span className="grow" />
            <button className="small" onClick={() => void copy()}>
              {copied ? <LuCheck /> : <LuCopy />} {copied ? 'Copied' : 'Copy public key'}
            </button>
            <button className="icon-btn small ghost" disabled={!!busy} onClick={() => void remove()} {...tip('Remove key')}>
              <LuTrash2 />
            </button>
          </div>
          <code className="ssh-key__pub">{sshKey.publicKey}</code>
          <span className="field__hint">
            Add it where it should get in: a repo's <b>Settings → Deploy keys</b> on GitHub (tick “Allow write access” to push), or the account's SSH keys.
          </span>
        </div>
      ) : (
        <span className="field__hint">No key: git over SSH (git@github.com:…) won't work with this identity. HTTPS with the GitHub CLI still does.</span>
      )}
      <div className="git-section__row git-section__row--start">
        <button className="small" disabled={!!busy} onClick={() => void generate()} {...tip('A new key made on the server; only the public half is shown')}>
          <LuWandSparkles /> {busy === 'gen' ? 'Making…' : sshKey ? 'New key' : 'Generate key'}
        </button>
        <button className="small ghost" disabled={!!busy} onClick={() => setPasting((v) => !v)} aria-expanded={pasting}>
          <LuUpload /> Use my own key
        </button>
      </div>
      {pasting && (
        <div className="ssh-key__upload">
          <textarea rows={5} className="mono" value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----'} spellCheck={false} autoComplete="off" />
          <input
            ref={file}
            type="file"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f && f.size < 20_000) setPrivateKey(await f.text())
            }}
          />
          <div className="git-section__row">
            <span className="field__hint">The private key (no passphrase). Stored for this identity only and never shown again.</span>
            <button className="small ghost" onClick={() => file.current?.click()}>
              Pick file…
            </button>
            <button className="small primary" disabled={!privateKey.trim() || !!busy} onClick={() => void upload()}>
              {busy === 'upload' ? 'Saving…' : 'Use this key'}
            </button>
          </div>
        </div>
      )}
      {error && <p className="danger-text">{error}</p>}
    </div>
  )
}

const rulesText = (match: string[]) => match.join('\n')
const rulesList = (text: string) => text.split(/[\n,]+/).map((r) => r.trim()).filter(Boolean)

/** An extra identity: its label, name, email, where it applies, and its key. */
function IdentityCard({ agent, identity, onDone }: { agent: OfficeAgent; identity?: GitIdentity; onDone?: () => void }) {
  const [label, setLabel] = useState(identity?.label ?? '')
  const [name, setName] = useState(identity?.name ?? '')
  const [email, setEmail] = useState(identity?.email ?? '')
  const [rules, setRules] = useState(rulesText(identity?.match ?? []))
  const [busy, setBusy] = useState<Busy>('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const run = (what: Busy, fn: () => Promise<unknown>) => attempt(setBusy, setError, what, fn)
  const body = () => ({ label: label.trim(), name: name.trim(), email: email.trim(), match: rulesList(rules) })
  const dirty =
    !identity || label.trim() !== identity.label || name.trim() !== identity.name || email.trim() !== identity.email || rulesText(rulesList(rules)) !== rulesText(identity.match)

  const save = async () => {
    const ok = await run('save', () => (identity ? liveApi.updateGitIdentity(agent.id, identity.id, body()) : liveApi.addGitIdentity(agent.id, body())))
    if (!ok) return
    if (!identity) return onDone?.()
    setSaved(true)
    setTimeout(() => setSaved(false), 1600)
  }
  const remove = async () => {
    if (!identity) return onDone?.()
    if (!(await confirm({ title: `Remove the identity “${identity.label}”?`, message: 'Its key is deleted too. Those projects fall back to the default identity.', confirmLabel: 'Remove identity' }))) return
    await run('delete', () => liveApi.removeGitIdentity(agent.id, identity.id))
  }

  return (
    <div className="git-identity">
      <div className="git-identity__head">
        <input className="git-identity__label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="Label, e.g. Acme (work)" aria-label="Label" />
        <button className="icon-btn small ghost" disabled={!!busy} onClick={() => void remove()} {...tip(identity ? 'Remove identity' : 'Cancel')}>
          <LuTrash2 />
        </button>
      </div>
      <div className="field-row">
        <Field label="Commit name">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={`e.g. ${agent.name} (Acme)`} />
        </Field>
        <Field label="Commit email">
          <input value={email} onChange={(e) => setEmail(e.target.value)} maxLength={120} placeholder={`e.g. ${handle(agent.name)}@acme.com`} type="email" />
        </Field>
      </div>
      <Field label="Used for" hint="One per line: a folder (~/after-office/project/acme) or repos by where they're hosted (github.com/acme, gitlab.com/team/app).">
        <textarea rows={2} className="mono" value={rules} onChange={(e) => setRules(e.target.value)} placeholder={'~/after-office/project/acme\ngithub.com/acme'} spellCheck={false} />
      </Field>
      <div className="git-section__row">
        {error ? <span className="danger-text grow">{error}</span> : <span className="grow" />}
        <button className="small primary" disabled={!dirty || !!busy || !name.trim() || !email.trim() || !rulesList(rules).length} onClick={() => void save()}>
          {saved ? <LuCheck /> : null} {busy === 'save' ? 'Saving…' : saved ? 'Saved' : identity ? 'Save' : 'Add identity'}
        </button>
      </div>
      {identity && <KeyBox agent={agent} sshKey={identity.sshKey} identity={identity.id} label={identity.label} />}
    </div>
  )
}

export function GitSection({ agent }: { agent: OfficeAgent }) {
  const [name, setName] = useState(agent.git?.name ?? '')
  const [email, setEmail] = useState(agent.git?.email ?? '')
  const [busy, setBusy] = useState<Busy>('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [adding, setAdding] = useState(false)

  // another dashboard (or this one's save) changed it: follow
  useEffect(() => setName(agent.git?.name ?? ''), [agent.git?.name])
  useEffect(() => setEmail(agent.git?.email ?? ''), [agent.git?.email])

  const dirty = name.trim() !== (agent.git?.name ?? '') || email.trim() !== (agent.git?.email ?? '')
  const save = async () => {
    if (await attempt(setBusy, setError, 'save', () => liveApi.setGit(agent.id, { name: name.trim(), email: email.trim() }))) {
      setSaved(true)
      setTimeout(() => setSaved(false), 1600)
    }
  }
  const identities = agent.gitIdentities ?? []

  return (
    <section className="git-section">
      <h4 className="git-section__title">
        <LuGitBranch /> Git
      </h4>
      <div className="git-identity git-identity--default">
        <span className="git-identity__kind">Default identity</span>
        <div className="field-row">
          <Field label="Commit name">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={`e.g. ${agent.name} (After Office)`} />
          </Field>
          <Field label="Commit email">
            <input value={email} onChange={(e) => setEmail(e.target.value)} maxLength={120} placeholder={`e.g. you+${handle(agent.name)}@example.com`} type="email" />
          </Field>
        </div>
        <div className="git-section__row">
          <span className="field__hint grow">Used wherever no other identity applies. Empty: git's own setting.</span>
          <button className="small" disabled={!dirty || !!busy} onClick={() => void save()}>
            {saved ? <LuCheck /> : null} {busy === 'save' ? 'Saving…' : saved ? 'Saved' : 'Save'}
          </button>
        </div>
        {error && <p className="danger-text">{error}</p>}
        <KeyBox agent={agent} sshKey={agent.sshKey} label="the default identity" />
      </div>

      {identities.map((g) => (
        <IdentityCard key={g.id} agent={agent} identity={g} />
      ))}
      {adding ? (
        <IdentityCard agent={agent} onDone={() => setAdding(false)} />
      ) : (
        <button className="small ghost git-section__add" onClick={() => setAdding(true)}>
          <LuPlus /> {identities.length ? 'Add another identity' : 'Add an identity for other projects'}
        </button>
      )}
      <span className="field__hint">Commits and pushes pick the identity whose folder or repos match; the default one otherwise. Applies right away.</span>
    </section>
  )
}
