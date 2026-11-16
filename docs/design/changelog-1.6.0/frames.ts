// Isolated release renders. Only the previously approved showcase is loaded.
import {
  fixtureAlbums, fixtureAnalytics, fixtureArtists, fixtureCustomRule, fixtureCustomTracks,
  fixtureDailyMinutes, fixtureHistory, fixtureIdentity, fixturePlaylists, fixturePeriods, fixtureTracks,
} from '/src/previews/changelog/fixtures.ts'
import { trackToUnified } from '/src/utils/unified.ts'
import { customMixRuleFingerprint } from '/src/features/mixes/snapshot.ts'
import showcase from '/docs/design/changelog-1.5.0/user-showcase.json'
import releaseNotes from '/docs/releases/v1.5.1.md?raw'

const frame = new URLSearchParams(location.search).get('frame') ?? 'home'
const tracks = fixtureTracks
const lyricsTrack = fixtureTracks.find(track => track.id === showcase.lyricClip.trackId)
const demoLines = [
  'В окнах медленно гаснет свет',
  'Мы идём по знакомым улицам',
  'Город прячет вчерашний след',
  'И шаги становятся музыкой',
  'До утра остаётся час',
  'Слышишь этот город?',
  'Этот свет на двоих у нас',
  'И дорога выводит к морю',
  'Пусть усталый трамвай уснёт',
  'Первый луч заполняет крыши',
  'Если ветер тебя позовёт',
  'Я останусь чуть ближе, слышишь',
]
const demoTrack = {
  ...(lyricsTrack ?? tracks[0]),
  title: 'Свет в окнах',
  artistName: 'Демо Tempo',
  durationSec: 116,
  coverPath: fixtureTracks.find(track => track.id === 471)?.coverPath ?? lyricsTrack?.coverPath,
}
const firstTrack = trackToUnified(frame === 'lyrics-view' ? demoTrack : tracks[0])
const darkCustom = {
  kind: 'custom',
  custom: {
    mode: 'auto',
    base: { background: '#e9e6f1', surface: '#e8dff1', accent: '#865bb3', playButton: '#865bb3' },
    overrides: {},
    gradientAnchors: { first: '#a898d3', second: '#ddb2bb' },
  },
}
const theme = frame === 'custom' ? darkCustom : { kind: 'preset', presetId: frame === 'hero' ? 'violet' : 'lilac-light' }
const start = ({
  library: 'library', track: 'library', albums: 'albums', album: 'albums',
  playlists: 'playlists', playlist: 'playlists', stats: 'playlists',
})[frame] ?? 'home'
const storage = new Map([['tempo.settings.v1', JSON.stringify({
  lang: 'ru', startupPage: start, theme,
  profile: { ...fixtureIdentity, onboarded: true },
  audio: { normalize: true, crossfadeSec: 3 },
  player: { waveform: true },
  lyrics: { whiteTextInLightTheme: frame === 'custom' || frame === 'lyrics-view', textFillMode: 'words', textSizePx: 31 },
  visualizer: { style: 'bars', bars: 36, useThemeColor: true },
  lyricsVisualizer: { style: 'wave', bars: 64, useThemeColor: true },
})]])
Object.defineProperty(window, 'localStorage', { value: {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key),
  clear: () => storage.clear(),
} })

const callbacks = new Map()
let callbackId = 0
const preferences = { volume: .71, playbackRate: .93, savedVolume: .71, savedPlaybackRate: .93 }
const audio = {
  currentTrack: firstTrack, queue: [firstTrack], queueIndex: 0, position: frame === 'lyrics-view' ? 50.5 : 42,
  duration: firstTrack.durationSec ?? 180, isPlaying: false,
  volume: .71, globalVolume: .8, playbackRate: .93, globalPlaybackRate: 1,
  preservePitch: true, repeat: 'off', shuffle: false, buffering: false, preparing: false,
  initialized: true, version: 1, trackPlaybackPreferences: preferences,
}
const album = fixtureAlbums.find(item => fixtureTracks.some(track => track.albumId === item.id)) ?? fixtureAlbums[0]
const playlist = fixturePlaylists.find(item => !item.isLikes) ?? fixturePlaylists[0]
const restartMix = { ...fixtureCustomRule, refreshIntervalMinutes: 60 }
const recommendations = fixtureTracks.filter(track => track.source === 'soundcloud' && track.externalId)
  .map(track => ({
    id: track.externalId, title: track.title, artist: track.artistName, artworkUrl: track.coverPath,
    durationMs: (track.durationSec ?? 0) * 1000, artistAvatarUrl: null, permalinkUrl: null,
    streamable: true, hasProgressive: false, hasHls: true,
  }))
const release = { version: '1.5.1', tag: 'v1.5.1', name: 'Tempo 1.5.1', publishedAt: '2026-11-12T00:00:00Z',
  notes: releaseNotes, assetName: null, assetUrl: null, assetSize: null }
const waveform = Array.from({ length: 144 }, (_, i) => (1 - Math.exp(-Math.min(i + 1, 145 - i) / 13)) *
  Math.min(1, .33 + .36 * Math.sin(i * .18) ** 2 + .24 * Math.sin(i * 1.42) ** 2))
const state = {
  native_audio_snapshot: audio, get_track_playback_preferences: preferences,
  sc_waveform: waveform, audio_waveform: waveform,
  check_services: {
    checkedAt: '2026-11-16T12:46:32.000Z',
    services: [
      ['soundcloud_api', 'SoundCloud API', 'api-v2.soundcloud.com', true, 'restricted', 142, 401],
      ['youtube_music_api', 'YouTube Music API', 'music.youtube.com', true, 'reachable', 190, 200],
      ['soundcloud_site', 'SoundCloud website', 'soundcloud.com', false, 'reachable', 117, 200],
      ['youtube_music_site', 'YouTube Music website', 'music.youtube.com', false, 'reachable', 184, 200],
      ['soundcloud_artwork', 'SoundCloud artwork', 'i1.sndcdn.com', false, 'reachable', 83, 200],
      ['lrclib', 'LRCLIB API', 'lrclib.net', false, 'reachable', 154, 200],
      ['tempo', 'Tempo updates', 'api.github.com', false, 'reachable', 104, 200],
      ['sc_waveforms', 'SoundCloud waveforms', 'wave.sndcdn.com', false, 'reachable', 113, 200],
      ['yt_artwork', 'YouTube artwork', 'i.ytimg.com', false, 'reachable', 94, 200],
      ['google_artwork', 'Google artwork', 'lh3.googleusercontent.com', false, 'reachable', 96, 200],
      ['genius', 'Genius API', 'genius.com', false, 'reachable', 148, 200],
      ['musixmatch', 'Musixmatch API', 'apic-desktop.musixmatch.com', false, 'restricted', 165, 401],
      ['deezer', 'Deezer API', 'api.deezer.com', false, 'reachable', 112, 200],
      ['wiki', 'Wikipedia API', 'en.wikipedia.org', false, 'reachable', 143, 200],
      ['ytdlp', 'yt-dlp updates', 'api.github.com', false, 'reachable', 108, 200],
      ['github_artwork', 'GitHub release artwork', 'raw.githubusercontent.com', false, 'reachable', 94, 200],
      ['wallhaven', 'Wallhaven API', 'wallhaven.cc', false, 'reachable', 128, 200],
      ['pinterest', 'Pinterest', 'www.pinterest.com', false, 'reachable', 144, 200],
      ['konachan', 'Konachan API', 'konachan.net', false, 'reachable', 160, 200],
      ['models', 'Hugging Face', 'huggingface.co', false, 'reachable', 149, 200],
      ['assets', 'Installer downloads', 'release-assets.githubusercontent.com', false, 'reachable', 121, 404],
      ['wallhaven_artwork', 'Wallhaven images', 'th.wallhaven.cc', false, 'reachable', 109, 200],
      ['pin_artwork', 'Pinterest images', 'i.pinimg.com', false, 'reachable', 92, 200],
      ['wiki_artwork', 'Wikimedia images', 'upload.wikimedia.org', false, 'reachable', 90, 200],
      ['discord_cover', 'Discord cover sharing', 'freeimage.host', false, 'reachable', 170, 200],
    ].map(([id, label, host, primary, status, latencyMs, httpStatus]) => ({ id, label, host, primary, status, latencyMs, httpStatus })),
  },
  count_tracks: tracks.length, list_tracks: tracks, list_artists: fixtureArtists,
  list_albums: fixtureAlbums, list_favorite_albums: fixtureAlbums.slice(0, 3),
  list_playlists: fixturePlaylists, get_analytics: fixtureAnalytics, get_history: fixtureHistory,
  get_daily_minutes: fixtureDailyMinutes, list_custom_mix_rules: [restartMix],
  get_hour_picks: fixtureTracks.slice(0, 24),
  get_library_folders: [{ id: 1, path: 'Музыка', trackCount: tracks.length }],
  get_home_page_data: {
    total: tracks.length, mixLibrary: tracks, played: fixtureHistory.map(item => item.track), dormantTracks: [],
    topTracks: fixtureAnalytics.topTracks, likedTracks: fixtureTracks.slice(0, 16),
    likesPlaylist: fixturePlaylists.find(item => item.isLikes) ?? null,
    featuredPlaylists: fixturePlaylists.slice(0, 7), hasPlaylistHistory: true,
  },
  get_recommendation_context: {
    generation: 0, seedTracks: [], likedTrackKeys: [], manuallySavedTrackKeys: [],
    sessions: [], impressions: [], features: [], storedState: null,
  },
  sc_cache_info: { path: 'Кэш SoundCloud', totalBytes: 318_560_000, fileCount: 107, limitBytes: 1_073_741_824 },
  get_covers_cache_info: { path: 'Обложки', totalBytes: 46_230_000, fileCount: 290 },
  sc_session_status: { browserAvailable: false, loginOpen: false },
  sc_recommendation_genre_search: { tracks: recommendations.slice(8), nextCursor: null },
  list_saved_backgrounds: fixtureAlbums.slice(0, 5).map(item => item.coverPath).filter(Boolean),
  get_background_provider_status: [],
  get_lyrics_override: frame === 'lyrics-view' ? {
    provider: 'manual', sourceArtist: demoTrack.artistName, sourceTitle: demoTrack.title,
    lrc: demoLines.map((line, index) => {
      const time = index * 9 + 4
      return `[0${Math.floor(time / 60)}:${String(time % 60).padStart(2, '0')}.00]${line}`
    }).join('\n'),
    offsetMs: 0, updatedAt: 0, isActive: true,
  } : null,
  lyrics_analysis_audio_identity: null,
  lyrics_analysis_get: null,
  updater_latest: { version: '1.5.1' },
  updater_releases: [release],
}

window.isTauri = true
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event, id) => callbacks.delete(id) }
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  convertFileSrc: path => new URL(path, location.origin).href,
  transformCallback(callback) {
    callbacks.set(++callbackId, callback)
    return callbackId
  },
  unregisterCallback: id => callbacks.delete(id),
  async invoke(command, args = {}) {
    if (command === 'plugin:event|listen') return args.handler
    if (command === 'plugin:app|version') return '1.6.0'
    if (command === 'native_audio_command') return null
    if (command === 'get_listening_period') {
      const series = fixturePeriods[0]
      const values = series.buckets
      const buckets = args.boundaries.slice(0, -1).map((from, index) => ({
        ...values[index % values.length], from, to: args.boundaries[index + 1],
      }))
      return { ...series, from: args.boundaries[0], to: args.boundaries.at(-1), buckets, previousActiveAt: null }
    }
    if (command === 'get_album') {
      const row = fixtureAlbums.find(item => item.id === args.albumId) ?? album
      return { album: row, tracks: tracks.filter(track => track.albumId === row.id) }
    }
    if (command === 'get_playlist') return fixtureCustomTracks.map((track, position) => ({ position, addedAt: track.addedAt, track }))
    if (command === 'is_favorite_album') return false
    if (command === 'get_custom_mix_snapshot') {
      return { ruleFingerprint: customMixRuleFingerprint(restartMix), tracks: fixtureCustomTracks, warnings: [], generatedAt: Math.floor(Date.now() / 1000) }
    }
    return Object.hasOwn(state, command) ? state[command] : command.startsWith('plugin:') ? null : []
  },
}

const waitFor = async (read, duration = 5000) => {
  const deadline = performance.now() + duration
  while (performance.now() < deadline) {
    const element = read()
    if (element) return element
    await new Promise(resolve => setTimeout(resolve, 35))
  }
  return null
}
const byText = (selector, text) => [...document.querySelectorAll(selector)].find(el => el.textContent.trim().includes(text))
const openCategory = async (area, section) => {
  const parent = await waitFor(() => document.querySelector('[aria-controls="settings-nav-' + area + '"]'))
  if (parent?.getAttribute('aria-expanded') !== 'true') parent?.click()
  if (!section) return
  const child = await waitFor(() => document.querySelector('.set-nav-child[aria-controls="settings-section-' + section + '"]'))
  child?.click()
}
const settingsFrames = {
  appearance: ['appearance'],
  light: ['appearance'],
  custom: ['appearance'],
  playback: ['general', 'audio'],
  player: ['appearance', 'player'],
  lyrics: ['appearance', 'lyrics'],
  visualizer: ['appearance', 'visualizers'],
  'lyrics-visualizer': ['appearance', 'visualizers'],
  wallpaper: ['appearance', 'wallpaper'],
  integrations: ['general', 'integrations'],
  processing: ['general', 'processing'],
  storage: ['storage', 'music-cache'],
  updates: ['about', 'updates'],
  network: ['about', 'service-status'],
}

if (frame === 'home' || frame === 'hero') {
  const { recommendationService } = await import('/src/features/recommendations/service.ts')
  const recommendationPreview = {
    ...recommendationService.getSnapshot(),
    tracks: recommendations.slice(0, 20),
    favoriteGenre: { key: 'alternative rock', label: 'Alternative Rock' },
    hasLoaded: true, hasMore: false, exhausted: true,
  }
  recommendationService.getSnapshot = () => recommendationPreview
}

await import('/src/main.tsx')
if (settingsFrames[frame]) {
  const settings = await waitFor(() => byText('.sidebar button', 'Настройки'))
  settings?.click()
  await openCategory(...settingsFrames[frame])
  if (frame === 'custom') {
    const controls = await waitFor(() => byText('.set-disclosure-summary', 'Своя тема') || byText('.set-disclosure-summary', 'Собственная тема'))
    controls?.scrollIntoView({ block: 'start' })
  }
  if (frame === 'lyrics-visualizer') {
    const button = await waitFor(() => document.querySelector('#settings-section-visualizers .set-preview-heading button'))
    button?.click()
  }
  if (frame === 'network') {
    (await waitFor(() => byText('#settings-section-service-status button', 'Проверить подключение')))?.click()
  }
  if (frame === 'updates') {
    (await waitFor(() => byText('#settings-section-updates button', 'Открыть меню обновлений')))?.click()
  }
} else if (frame === 'profile') {
  (await waitFor(() => byText('.sidebar button', fixtureIdentity.nickname)))?.click()
} else if (frame === 'lyrics-view') {
  (await waitFor(() => document.querySelector('.pb-lyrics-btn')))?.click()
} else if (frame === 'track') {
  const row = await waitFor(() => document.querySelector('.tl-row'))
  const bounds = row?.getBoundingClientRect()
  row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: bounds.left + 100, clientY: bounds.top + 12 }))
  ;(await waitFor(() => document.querySelector('.track-playback-menu-entry')))?.click()
} else if (frame === 'album') {
  (await waitFor(() => byText('button', album.title)))?.click()
} else if (frame === 'playlist' || frame === 'stats') {
  (await waitFor(() => byText('button', playlist.name)))?.click()
  if (frame === 'stats') {
    (await waitFor(() => document.querySelector('.collection-detail [aria-label="Посмотреть статистику"]')))?.click()
  }
}
