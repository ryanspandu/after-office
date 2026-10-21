import { lazy, type ComponentType } from 'react'
import { reloadApp } from './install'
import { useAppUpdate } from './register'

// A lazy part of the app (editor, PDF/Word preview, rich notes) can fail to load: a flaky network, or a deploy that
// replaced the chunk this tab was built against. Never reload the page for it: try the import once more, then show a
// short note in place of that part and light up the reload button (ui/AppReload.tsx), so the owner picks the moment.

const RETRY_AFTER_MS = 1500

function Unavailable() {
  return <div className="empty muted">This part couldn’t load (the app may have been updated). Reload to get it.</div>
}

/** React.lazy, with one retry and a fallback instead of a crash when the chunk can't be loaded. */
export function lazyRetry<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load()
      .catch(() => new Promise<{ default: T }>((ok, fail) => setTimeout(() => load().then(ok, fail), RETRY_AFTER_MS)))
      .catch((e) => {
        console.warn('[pwa] lazy chunk failed to load:', e)
        if (!useAppUpdate.getState().ready) useAppUpdate.setState({ ready: true, apply: () => void reloadAfterChunkError() })
        return { default: Unavailable as unknown as T }
      }),
  )
}

// the button's own path (looks for a waiting worker first), with the "ready" we set cleared so it doesn't loop back here
function reloadAfterChunkError() {
  useAppUpdate.setState({ ready: false, apply: () => {} })
  return reloadApp()
}
