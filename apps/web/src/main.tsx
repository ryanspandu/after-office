import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { AuthGate } from './ui/AuthGate'
import { TooltipLayer } from './ui/Tooltip'
import { trackVisualViewport } from './state/visualViewport'
import { tapToType } from './state/tapToType'
import './styles.css'
import './pwa/install' // listens for the install prompt from the very start
import { registerServiceWorker } from './pwa/register'
import { syncThemeColor } from './pwa/themeColor'
import { loadBranding } from './state/branding'

trackVisualViewport()
tapToType()
syncThemeColor()
registerServiceWorker()
void loadBranding()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
    <TooltipLayer />
  </StrictMode>,
)
