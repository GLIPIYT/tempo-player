import ReactDOM from 'react-dom/client'
import MiniPlayerApp from './MiniPlayerApp'
import { applyFont, applyTheme } from '../theme/engine'
import { loadSettings } from '../state/settings'
import './mini-player.css'

// Both webviews use shared settings at boot, then the mini player receives theme changes from the bridge.
const { theme, font } = loadSettings()
applyTheme(theme)
applyFont(font)

// no StrictMode here: its double-invoked effects would create and tear down the
// event listeners twice, which is visible in a window this small
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<MiniPlayerApp />)
