import PageOutlet from './app/PageOutlet'
import AppBackgroundEffects from './app/AppBackgroundEffects'
import { DevProfile } from './dev-performance/DevProfile'
import Sidebar from './components/layout/Sidebar'
import TopBar from './components/layout/TopBar'
import PlayerBar from './components/layout/PlayerBar'
import TitleBar from './components/layout/TitleBar'
import ListeningHistoryHost from './features/listening-history/ListeningHistoryHost'
import Onboarding from './components/onboarding/Onboarding'
import PresenceBridge from './components/integration/PresenceBridge'
import LyricsAnalysisBridge from './components/integration/LyricsAnalysisBridge'
import MiniPlayerBridge from './components/integration/MiniPlayerBridge'
import SystemBridge from './components/integration/SystemBridge'
import LoudnessBridge from './components/integration/LoudnessBridge'
import ContextMenuHost from './components/common/ContextMenu'
import TrackDragLayer from './dnd/trackDrag'
import { NavProvider } from './state/nav'
import { SettingsProvider } from './state/settings'
import { I18nProvider } from './i18n'
import { ThemeApply } from './theme/engine'
import UpdateWatcher from './updater/UpdateWatcher'
import CacheToasts from './soundcloud/CacheToasts'
import CacheChoiceDialog from './soundcloud/CacheChoiceDialog'
import YtdlpBootstrapper from './providers/YtdlpBootstrapper'
import SaveToasts from './youtube/SaveToasts'
import SavePickDialog from './youtube/SavePickDialog'
import CacheArtistDialog from './soundcloud/CacheArtistDialog'
import BackgroundLayer from './components/layout/BackgroundLayer'
import { ToastHost } from './components/common/Toast'
import './styles/app.css'
import './styles/collections.css'
import './styles/home.css'

function Shell() {
  return (
    <>
      <div className="app-root">
        <TitleBar />
        <div className="app-shell">
          <Sidebar />
          <div className="app-main">
            <TopBar />
            <main className="app-content">
              <PageOutlet />
            </main>
          </div>
          <DevProfile id="player"><PlayerBar /></DevProfile>
        </div>
        <AppBackgroundEffects />
        <LyricsAnalysisBridge />
        <PresenceBridge />
        <MiniPlayerBridge />
        <SystemBridge />
        <LoudnessBridge />
        <UpdateWatcher />
        <CacheToasts />
        <CacheChoiceDialog />
        <CacheArtistDialog />
        <YtdlpBootstrapper />
        <SaveToasts />
        <SavePickDialog />
      </div>
      {/* Fixed-position overlays live outside .app-root: applyFont() sets a zoom
          on it for the UI scale preference, and a zoomed ancestor makes
          position:fixed resolve against that ancestor instead of the viewport,
          which dragged the ghost away from the cursor. */}
      <TrackDragLayer />
      <ToastHost />
      <Onboarding />
      <ContextMenuHost />
      <ListeningHistoryHost />
    </>
  )
}

export default function App() {
  return (
    <SettingsProvider>
      <I18nProvider>
        <ThemeApply />
        <BackgroundLayer />
        <NavProvider>
          <Shell />
        </NavProvider>
      </I18nProvider>
    </SettingsProvider>
  )
}
