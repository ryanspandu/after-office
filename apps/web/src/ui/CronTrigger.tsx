import { useEffect, useState } from 'react'
import { LuCheck, LuCopy, LuRefreshCw } from 'react-icons/lu'
import type { CronJob } from '@after-office/shared'
import { liveApi } from '../state/live'

// Webhook trigger for a cron job: a secret URL other services (CI, GitHub, a form…) can POST to, to run the job now.
// Whatever they send is appended to the prompt as data. Applies immediately (not with the modal's Save).

export function CronTrigger({ cron }: { cron: CronJob }) {
  const [info, setInfo] = useState<{ url: string; token: string } | null>(null)
  const [on, setOn] = useState(!!cron.trigger)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  // only the URL comes back later: the token is shown once, right after it is made (the server keeps only a hash)
  useEffect(() => {
    if (cron.trigger) liveApi.cronTrigger(cron.id).then((r) => r && setInfo((cur) => cur ?? { url: r.url, token: '' })).catch(() => {})
  }, [cron.id, cron.trigger])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const create = () => run(async () => setInfo(await liveApi.createCronTrigger(cron.id)))
  const toggle = (next: boolean) =>
    run(async () => {
      if (next) setInfo(await liveApi.createCronTrigger(cron.id))
      else {
        await liveApi.removeCronTrigger(cron.id)
        setInfo(null)
      }
      setOn(next)
    })
  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(null), 1500)
    })
  }
  const curl = info ? `curl -X POST -H 'Authorization: Bearer ${info.token}' -d '{"note":"from CI"}' ${info.url}` : ''

  return (
    <div className="cron-trigger">
      <label className="switch-row">
        <span className="toggle">
          <input type="checkbox" checked={on} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
          <span />
        </span>
        <span>
          <span className="switch-row__label">Webhook trigger</span>
          <span className="field__hint">A secret URL that runs this job now (at most once a minute). What the caller sends is added to the prompt as data.</span>
        </span>
      </label>
      {on && info && (
        <div className="cron-trigger__box">
          <div className="cron-trigger__row">
            <code className="truncate">{info.url}</code>
            <button type="button" className="icon-btn small ghost" data-tip="Copy URL" aria-label="Copy URL" onClick={() => copy('url', info.url)}>
              {copied === 'url' ? <LuCheck /> : <LuCopy />}
            </button>
          </div>
          <div className="cron-trigger__row">
            {info.token ? (
              <>
                <code className="truncate">curl -X POST -H 'Authorization: Bearer ••••' …</code>
                <button type="button" className="icon-btn small ghost" data-tip="Copy curl example (with the token)" aria-label="Copy curl example" onClick={() => copy('curl', curl)}>
                  {copied === 'curl' ? <LuCheck /> : <LuCopy />}
                </button>
              </>
            ) : (
              <span className="field__hint grow">The token is only shown when it's made. Lost it? Make a new one.</span>
            )}
            <button type="button" className="icon-btn small ghost" data-tip="New token (the old one stops working)" aria-label="Regenerate token" disabled={busy} onClick={() => void create()}>
              <LuRefreshCw />
            </button>
          </div>
          {info.token && <span className="field__hint">Copy it now: the token won't be shown again.</span>}
        </div>
      )}
      {error && <div className="row__error">{error}</div>}
    </div>
  )
}
