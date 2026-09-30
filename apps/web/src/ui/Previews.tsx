import { useEffect, useState } from 'react'
import { LuExternalLink, LuMonitorPlay } from 'react-icons/lu'
import { api } from '../state/auth'

// Previews: the apps agents are running on preview ports (3000–3009 by default), with a link to open each one. On a
// server they come through the dashboard's preview proxy (signed-in only, your session never reaches the app).

interface Preview {
  port: number
  url: string
  title: string | null
}

/** Running previews, checked every 10 s while shown. Nothing running: nothing shown. */
export function Previews() {
  const [list, setList] = useState<Preview[]>([])
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
        <a key={p.port} className="preview-row" href={p.url} target="_blank" rel="noreferrer noopener" data-tip={`Open ${p.url}`}>
          <span className="preview-row__port">:{p.port}</span>
          <span className="truncate">{p.title ?? 'App preview'}</span>
          <LuExternalLink className="preview-row__go" />
        </a>
      ))}
    </div>
  )
}
