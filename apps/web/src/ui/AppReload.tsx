import { LuRotateCw } from 'react-icons/lu'
import { reloadApp, useInstall } from '../pwa/install'
import { useAppUpdate } from '../pwa/register'
import { tip } from './Tooltip'

/**
 * Reload, floating on the 3D stage, for the installed app (it has no browser reload button). The app looks for a new
 * version by itself (pwa/register.ts); when one is ready this lights up as "Update" and takes it.
 */
export function AppReload() {
  const installed = useInstall((s) => s.installed)
  const ready = useAppUpdate((s) => s.ready)
  if (!installed) return null
  return (
    <button
      className={`app-reload${ready ? ' app-reload--update' : ''}`}
      {...tip(ready ? 'A new version is ready: reload to use it' : 'Reload the app')}
      onClick={() => void reloadApp()}
    >
      <LuRotateCw />
      {ready && <span>Update</span>}
    </button>
  )
}
