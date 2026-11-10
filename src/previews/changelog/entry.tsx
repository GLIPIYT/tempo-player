import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api } from '../../api/client'
import AlbumsPage from '../../pages/AlbumsPage'
import ProfilePage from '../../pages/ProfilePage'
import CustomMixEditor from '../../components/home/CustomMixEditor'
import HomeMixFeature from '../../components/home/HomeMixFeature'
import ListeningHistoryDialog from '../../features/listening-history/ListeningHistoryDialog'
import { I18nProvider } from '../../i18n'
import { NavProvider } from '../../state/nav'
import { defaultSettings, SettingsProvider } from '../../state/settings'
import { ThemeApply } from '../../theme/engine'
import { fixtureAlbums, fixtureAnalytics, fixtureArtists, fixtureCustomRule, fixtureCustomTracks, fixtureDailyMinutes, fixtureHistory, fixtureIdentity, fixturePeriods, fixturePlaylists, fixtureTracks } from './fixtures'
import { playerContext } from '../../player/usePlayer'
import type { PlayerApi } from '../../player/types'
import type { HourMix } from '../../utils/hourMixes'
import '../../styles/home.css'
import './changelogPreview.css'
import '../../styles/global.css'
import '../../styles/app.css'

const settings = {
  ...defaultSettings,
  lang: 'ru' as const,
  theme: { kind: 'preset' as const, presetId: 'violet' },
  profile: { ...defaultSettings.profile, ...fixtureIdentity },
}
localStorage.setItem('tempo.settings.v1', JSON.stringify(settings))

Object.assign(api, {
  getAnalytics: async () => fixtureAnalytics,
  getDailyMinutes: async (days: number) => fixtureDailyMinutes.slice(-days),
  getHistory: async (limit: number) => fixtureHistory.slice(0, limit),
  listPlaylists: async () => fixturePlaylists,
  listArtists: async () => fixtureArtists,
  listAlbums: async () => fixtureAlbums,
  listFavoriteAlbums: async () => fixtureAlbums.slice(0, 2),
  getAlbum: async (albumId: number) => ({
    album: fixtureAlbums.find(album => album.id === albumId) ?? fixtureAlbums[0],
    tracks: fixtureTracks.filter(track => track.albumId === albumId),
  }),
  isFavoriteAlbum: async (albumId: number) => albumId <= 2,
  toggleFavoriteAlbum: async (albumId: number) => albumId > 2,
  getListeningPeriod: async (boundaries: number[]) => {
    const from = boundaries[0] ?? 0
    const to = boundaries[boundaries.length - 1] ?? from
    const period = fixturePeriods.find(item => item.from === from && item.to === to)
    if (!period) throw new Error('This isolated capture contains the two displayed months only')
    return period
  },
})

function RuleFixture() {
  const [open, setOpen] = useState(true)
  const rule = fixtureCustomRule
  if (!open) return <button className="changelog-reopen" onClick={() => setOpen(true)}>Открыть правило</button>
  return <CustomMixEditor
    initial={rule}
    presets={[]}
    genres={['Alternative Rock', 'Indie', 'Shoegaze', 'Post-punk']}
    onSave={async () => setOpen(false)}
    onClose={() => setOpen(false)}
  />
}

function HistoryFixture() {
  const [open, setOpen] = useState(true)
  return open ? <ListeningHistoryDialog initialSelection={{ kind: 'month', date: '2026-11-01' }} onClose={() => setOpen(false)} />
    : <button className="changelog-reopen" onClick={() => setOpen(true)}>Открыть историю</button>
}

const mode = new URLSearchParams(location.search).get('mode') ?? 'profile'

const fakePlayer: PlayerApi = {
  currentTrack: null,
  queue: [],
  queueIndex: -1,
  isPlaying: false,
  position: 0,
  duration: 0,
  volume: 0.72,
  playbackRate: 1,
  preservePitch: true,
  repeat: 'off',
  shuffle: false,
  bufferPct: null,
  preparing: false,
  playTracks: () => undefined,
  updateTrackMetadata: () => undefined,
  toggle: () => undefined,
  next: () => undefined,
  previous: () => undefined,
  seek: () => undefined,
  setVolume: () => undefined,
  setPlaybackRate: () => undefined,
  setPreservePitch: () => undefined,
  setEqualizer: () => undefined,
  setRepeat: () => undefined,
  toggleShuffle: () => undefined,
  addToQueue: () => undefined,
  removeFromQueue: () => undefined,
  moveInQueue: () => undefined,
  clearQueue: () => undefined,
}

function AlbumFixture() {
  return <playerContext.Provider value={fakePlayer}>
    <main className="app-content changelog-content"><AlbumsPage /></main>
  </playerContext.Provider>
}

const fixtureMixes: HourMix[] = [
  { key: `custom:${fixtureCustomRule.id}`, kind: 'custom', title: fixtureCustomRule.name, description: fixtureCustomRule.description, tracks: fixtureCustomTracks, rule: fixtureCustomRule },
  { key: 'mix', kind: 'hour', title: 'Музыка на этот час', description: 'Picked from what you usually play around this time of day', tracks: [...fixtureTracks].reverse() },
  { key: 'smart:on-repeat', kind: 'smart', title: 'На повторе', description: 'Tracks you return to most often', tracks: fixtureTracks.slice(0, 6) },
]

function HomeMixFixture() {
  return <main className="app-content changelog-content"><HomeMixFeature
    mixes={fixtureMixes}
    onPlay={() => undefined}
    onOpen={() => undefined}
    onMixMenu={event => event.preventDefault()}
    onSectionMenu={event => event.preventDefault()}
    onCreateRule={() => undefined}
    onReorder={() => undefined}
  /></main>
}

function Preview() {
  return <SettingsProvider>
    <I18nProvider>
      <NavProvider>
        <ThemeApply />
        {mode === 'rule' ? <RuleFixture /> : mode === 'library' ? <AlbumFixture /> : mode === 'home' ? <HomeMixFixture />
          : mode === 'history' ? <HistoryFixture />
          : <main className="app-content changelog-content"><ProfilePage /></main>}
      </NavProvider>
    </I18nProvider>
  </SettingsProvider>
}

createRoot(document.getElementById('root')!).render(<StrictMode><Preview /></StrictMode>)
