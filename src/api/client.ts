import { invoke } from '@tauri-apps/api/core'
import type {
  Album,
  AlbumDetail,
  AnalyticsData,
  AnalyticsPeriod,
  Artist,
  ArtistDetail,
  CoversCacheInfo,
  HistoryEntry,
  LibraryFolder,
  Playlist,
  PlaylistTrack,
  ScanSummary,
  ScTrack,
  SearchResults,
  Track,
} from '../types/models'

function periodSinceSecs(period: AnalyticsPeriod): number | null {
  if (period === 'all') return null
  const now = new Date()
  if (period === 'today') {
    return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
  }
  const days = period === '7d' ? 7 : 30
  return Math.floor(now.getTime() / 1000) - days * 86400
}

export const api = {
  listLibraryFolders: () => invoke<LibraryFolder[]>('get_library_folders'),
  addLibraryFolder: (path: string) => invoke<LibraryFolder>('add_library_folder', { path }),
  removeLibraryFolder: (folderId: number) =>
    invoke<void>('remove_library_folder', { folderId }),

  rescanFolder: (folderId: number) => invoke<ScanSummary>('rescan_folder', { folderId }),
  rescanLibrary: (force = false) => invoke<ScanSummary>('rescan_library', { force }),

  listTracks: (query: string, limit: number, offset: number) =>
    invoke<Track[]>('list_tracks', { query, limit, offset }),
  countTracks: () => invoke<number>('count_tracks'),
  searchAll: (query: string) => invoke<SearchResults>('search_all', { query }),

  listAlbums: (query: string) => invoke<Album[]>('list_albums', { query }),
  getAlbum: (albumId: number) => invoke<AlbumDetail>('get_album', { albumId }),
  listArtists: (query: string) => invoke<Artist[]>('list_artists', { query }),
  getArtist: (artistId: number) => invoke<ArtistDetail>('get_artist', { artistId }),

  createPlaylist: (name: string) => invoke<Playlist>('create_playlist', { name }),
  renamePlaylist: (playlistId: number, name: string) =>
    invoke<void>('rename_playlist', { playlistId, name }),
  deletePlaylist: (playlistId: number) => invoke<void>('delete_playlist', { playlistId }),
  listPlaylists: () => invoke<Playlist[]>('list_playlists'),
  getPlaylist: (playlistId: number) => invoke<PlaylistTrack[]>('get_playlist', { playlistId }),
  playlistAddTrack: (playlistId: number, trackId: number) =>
    invoke<void>('playlist_add_track', { playlistId, trackId }),
  playlistRemoveTrack: (playlistId: number, trackId: number) =>
    invoke<void>('playlist_remove_track', { playlistId, trackId }),
  playlistMoveTrack: (playlistId: number, fromPos: number, toPos: number) =>
    invoke<void>('playlist_move_track', { playlistId, fromPos, toPos }),

  bumpPlayCount: (trackId: number) => invoke<void>('bump_play_count', { trackId }),
  recordHistory: (trackId: number, listenedSec: number | null, completed: boolean, skipped: boolean) =>
    invoke<void>('record_history', { trackId, listenedSec, completed, skipped }),

  setPlaylistPinned: (playlistId: number, pinned: boolean) =>
    invoke<void>('set_playlist_pinned', { playlistId, pinned }),
  movePinnedPlaylist: (playlistId: number, newOrder: number) =>
    invoke<void>('move_pinned_playlist', { playlistId, newOrder }),

  getAppSetting: (key: string) => invoke<string | null>('get_app_setting', { key }),
  setAppSetting: (key: string, value: string) => invoke<void>('set_app_setting', { key, value }),

  getTrackLyrics: (trackId: number) => invoke<string | null>('get_track_lyrics', { trackId }),

  importFont: (path: string) => invoke<string>('import_font', { path }),
  importBackground: (path: string) => invoke<string>('import_background', { path }),

  getAnalytics: (period: AnalyticsPeriod) =>
    invoke<AnalyticsData>('get_analytics', { sinceSecs: periodSinceSecs(period) }),
  clearHistory: () => invoke<void>('clear_history'),

  getCoversCacheInfo: () => invoke<CoversCacheInfo>('get_covers_cache_info'),
  clearCoversCache: () => invoke<void>('clear_covers_cache'),
  getHistory: (limit: number, offset: number) =>
    invoke<HistoryEntry[]>('get_history', { limit, offset }),

  setTaskbarProgress: (position: number, duration: number, playing: boolean) =>
    invoke<void>('set_taskbar_progress', { position, duration, playing }),

  scSearchTracks: (query: string, limit: number, offset: number) =>
    invoke<ScTrack[]>('sc_search_tracks', { query, limit, offset }),

  scGetPlayback: (trackId: string) =>
    invoke<{ url: string | null; cachedPath: string | null; format: string | null }>('sc_get_playback', {
      trackId,
    }),
  fetchOnlineLyricsAll: (artist: string, title: string) =>
    invoke<Array<{ provider: string; plain: string | null; syncedLrc: string | null }>>('fetch_online_lyrics_all', {
      artist,
      title,
    }),
  addScTrackToPlaylist: (playlistId: number, track: ScTrack) =>
    invoke<number>('add_sc_track_to_playlist', { playlistId, track }),
  scCacheInfo: () =>
    invoke<{ path: string; totalBytes: number; fileCount: number }>('sc_cache_info'),
  setScCacheDir: (path: string) => invoke<void>('set_sc_cache_dir', { path }),
  clearScCache: () => invoke<void>('clear_sc_cache'),

  fetchOnlineLyrics: (artist: string, title: string) =>
    invoke<{ plain: string | null; syncedLrc: string | null } | null>('fetch_online_lyrics', {
      artist,
      title,
    }),
}
