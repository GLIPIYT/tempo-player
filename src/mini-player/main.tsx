import ReactDOM from 'react-dom/client'
import MiniPlayerApp from './MiniPlayerApp'
import { applyFont, applyTheme } from '../theme/engine'
import type { AppSettings } from '../state/settings'
import type { ActiveTheme } from '../types/theme'
import './mini-player.css'

const SETTINGS_KEY = 'tempo.settings.v1'

/**
 * The mini player is a separate webview, so theme tokens written by the main
 * window do not reach it. Both windows share an origin and therefore the same
 * `localStorage`, so the last saved settings can be read here at boot; after
 * that the bridge keeps the theme in sync through the state event.
 */
function readStoredAppearance(): { theme?: ActiveTheme; font?: AppSettings['font'] } {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    return { theme: parsed.theme, font: parsed.font }
  } catch {
    return {}
  }
}

const appearance = readStoredAppearance()
if (appearance.theme) applyTheme(appearance.theme)
if (appearance.font) applyFont(appearance.font)

// no StrictMode here: its double-invoked effects would create and tear down the
// event listeners twice, which is visible in a window this small
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<MiniPlayerApp />)
