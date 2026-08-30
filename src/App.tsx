import { useEffect } from 'react'
import Sidebar from './components/layout/Sidebar'
import TopBar from './components/layout/TopBar'
import PlayerBar from './components/layout/PlayerBar'
import TitleBar from './components/layout/TitleBar'
import HomePage from './pages/HomePage'
import LibraryPage from './pages/LibraryPage'
import AlbumsPage from './pages/AlbumsPage'
import ArtistsPage from './pages/ArtistsPage'
import PlaylistsPage from './pages/PlaylistsPage'
import HistoryPage from './pages/HistoryPage'
import SettingsPage from './pages/SettingsPage'
import SearchPage from './pages/SearchPage'
import AlbumDetailPage from './pages/AlbumDetailPage'
import ArtistDetailPage from './pages/ArtistDetailPage'
import PlaylistDetailPage from './pages/PlaylistDetailPage'
import { NavProvider, useNav } from './state/nav'
import { usePlayer } from './player'
import PlayerProvider from './player/PlayerProvider'
import { SettingsProvider } from './state/settings'
import { I18nProvider } from './i18n'
import { ThemeApply } from './theme/engine'
import BackgroundLayer from './components/layout/BackgroundLayer'
import { onScanProgress } from './api/events'
import { api } from './api/client'
import { bumpLibraryVersion } from './utils/libraryVersion'
import { likesStore } from './utils/likesStore'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import './styles/app.css'

function CurrentPage() {
  const { view } = useNav()
  switch (view.name) {
    case 'home':
      return <HomePage />
    case 'library':
      return <LibraryPage />
    case 'albums':
      return <AlbumsPage />
    case 'artists':
      return <ArtistsPage />
    case 'playlists':
      return <PlaylistsPage />
    case 'history':
      return <HistoryPage />
    case 'settings':
      return <SettingsPage />
    case 'search':
      return <SearchPage />
    case 'album':
      return <AlbumDetailPage albumId={view.id} />
    case 'artist':
      return <ArtistDetailPage artistId={view.id} />
    case 'playlist':
      return <PlaylistDetailPage playlistId={view.id} />
  }
}

function Shortcuts() {
  const player = usePlayer()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.code === 'Space') {
        e.preventDefault()
        player.toggle()
      } else if (e.code === 'ArrowRight') {
        player.seek(player.position + 5)
      } else if (e.code === 'ArrowLeft') {
        player.seek(Math.max(0, player.position - 5))
      } else if (e.code === 'ArrowUp') {
        e.preventDefault()
        player.setVolume(Math.min(1, player.volume + 0.05))
      } else if (e.code === 'ArrowDown') {
        e.preventDefault()
        player.setVolume(Math.max(0, player.volume - 0.05))
      } else if (e.code === 'KeyM') {
        player.setVolume(player.volume > 0 ? 0 : 0.8)
      } else if (e.code === 'KeyS') {
        player.toggleShuffle()
      } else if (e.code === 'KeyR') {
        player.setRepeat(player.repeat === 'off' ? 'all' : player.repeat === 'all' ? 'one' : 'off')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [player])
  return null
}

function ScanWatcher() {
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void onScanProgress((p) => {
      if (p.phase === 'completed') bumpLibraryVersion()
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])
  return null
}

function FolderDropWatcher() {
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== 'drop') return
        const paths = event.payload.paths
        if (paths.length === 0) return
        void api
          .addLibraryFolder(paths[0])
          .then(() => api.rescanLibrary())
          .then(() => bumpLibraryVersion())
          .catch(() => {})
      })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])
  return null
}

function TaskbarProgress() {
  const player = usePlayer()
  const position = Math.round(player.position)
  const duration = Math.round(player.duration)
  useEffect(() => {
    if (!player.currentTrack) return
    void api.setTaskbarProgress(position, duration, player.isPlaying).catch(() => {})
  }, [player.currentTrack, player.isPlaying, position, duration])
  return null
}

function Shell() {
  useEffect(() => {
    likesStore.ensureLoaded()
  }, [])
  return (
    <div className="app-root">
      <TitleBar />
      <div className="app-shell">
        <Sidebar />
        <div className="app-main">
          <TopBar />
          <main className="app-content">
            <CurrentPage />
          </main>
        </div>
        <PlayerBar />
      </div>
      <Shortcuts />
      <ScanWatcher />
      <FolderDropWatcher />
      <TaskbarProgress />
    </div>
  )
}

export default function App() {
  return (
    <SettingsProvider>
      <I18nProvider>
        <ThemeApply />
        <BackgroundLayer />
        <PlayerProvider>
          <NavProvider>
            <Shell />
          </NavProvider>
        </PlayerProvider>
      </I18nProvider>
    </SettingsProvider>
  )
}
