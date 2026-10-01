import { useEffect, useState } from 'react'
import { LuExternalLink, LuLoader, LuMonitorPlay, LuSquare } from 'react-icons/lu'
import { confirm } from './Confirm'
import { api } from '../state/auth'

// Previews: the apps agents are running on preview ports (3000–3009 by default), with a link to open each one. On a
// server they come through the dashboard's preview proxy (signed-in only, your session never reaches the app). Each one
// can be stopped from here (the app goes, the port frees up).

interface Preview {
  port: number
  url: string
  title: string | null
}

/** Running previews, checked every 10 s while shown. Nothing running: nothing shown. */
export function Previews() {
  const [list, setList] = useState<Preview[]>([])
  const [stopping, setStopping] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = () =>
    api('/api/previews')
      .then((r) => (r.ok ? r.json() : []))
      .then((l: Preview[]) => setList(l))
      .catch(() => {})
  const stop = async (p: Preview) => {
    const ok = await confirm({
      title: `Stop the app on :${p.port}?`,
      message: `${p.title ?? 'The app'} stops and the port frees up. The agent can start it again.`,
      confirmLabel: 'Stop',
    })
    if (!ok) return
    setStopping(p.port)
    setError(null)
    try {
      const r = await api(`/api/previews/${p.port}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const body = await r.json().catch(() => null)
      if (!r.ok) throw new Error(body?.error ?? 'Could not stop it')
      if (!body?.stopped) throw new Error(`:${p.port} is still running`)
      setList((cur) => cur.filter((x) => x.port !== p.port))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setStopping(null)
      void refresh()
    }
  }
  useEffect(() => {
    let alive = true
    const load = () =>
      api('/api/previews')
        .then((r) => (r.ok ? r.json() : []))
        .then((l: Preview[]) => alive && setList(l))
        .catch(() => {})
    void load()
    const id = setInterval(load, 10_000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])
  if (!list.length) return null
  return (
    <div className="previews">
      <span className="previews__head">
        <LuMonitorPlay /> Running now
      </span>
      {list.map((p) => (
        <div key={p.port} className="preview-item">
          <a className="preview-row" href={p.url} target="_blank" rel="noreferrer noopener" data-tip={`Open ${p.url}`}>
            <span className="preview-row__port">:{p.port}</span>
            <span className="truncate">{p.title ?? 'App preview'}</span>
            <LuExternalLink className="preview-row__go" />
          </a>
          <button className="icon-btn small ghost preview-row__stop" onClick={() => void stop(p)} disabled={stopping === p.port} data-tip="Stop this app" aria-label={`Stop the app on port ${p.port}`}>
            {stopping === p.port ? <LuLoader className="spin" /> : <LuSquare />}
          </button>
        </div>
      ))}
      {error && <div className="row__error">{error}</div>}
    </div>
  )
}
