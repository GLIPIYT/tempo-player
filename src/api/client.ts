import { invoke } from '@tauri-apps/api/core'
import type {
  Album,
  AlbumDetail,
  AnalyticsData,
  AnalyticsPeriod,
  Artist,
  ArtistDetail,
  CoversCacheInfo,
  DailyMinutes,
  FavoriteOrderEntry,
  HiddenTrack,
  HistoryEntry,
  LibraryFolder,
  LyricsOverride,
  Playlist,
  PlaylistTrack,
  ScanSummary,
  ScTrack,
  SearchResults,
  TopTrackItem,
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

  listTracks: (query: string, limit: number, offset: number, sort = 'added') =>
    invoke<Track[]>('list_tracks', { query, limit, offset, sort }),
  countTracks: () => invoke<number>('count_tracks'),
  searchAll: (query: string) => invoke<SearchResults>('search_all', { query }),

  listAlbums: (query: string) => invoke<Album[]>('list_albums', { query }),
  getAlbum: (albumId: number) => invoke<AlbumDetail>('get_album', { albumId }),
  listArtists: (query: string) => invoke<Artist[]>('list_artists', { query }),
  getArtist: (artistId: number) => invoke<ArtistDetail>('get_artist', { artistId }),
  getArtistTracks: (artistId: number) => invoke<Track[]>('get_artist_tracks', { artistId }),

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

  likeTrack: (trackId: number) => invoke<void>('like_track', { trackId }),
  unlikeTrack: (trackId: number) => invoke<void>('unlike_track', { trackId }),
  listLikedTrackIds: () => invoke<number[]>('list_liked_track_ids'),

  getTopTracks: (limit: number) =>
    invoke<TopTrackItem[]>('get_top_tracks', { limit }),
  getHourPicks: (limit: number) => invoke<Track[]>('get_hour_picks', { limit }),

  setPlaylistPinned: (playlistId: number, pinned: boolean) =>
    invoke<void>('set_playlist_pinned', { playlistId, pinned }),
  movePinnedPlaylist: (playlistId: number, newOrder: number) =>
    invoke<void>('move_pinned_playlist', { playlistId, newOrder }),

  listFavoritesOrder: () => invoke<FavoriteOrderEntry[]>('list_favorites_order'),
  setFavoritesOrder: (items: FavoriteOrderEntry[]) =>
    invoke<void>('set_favorites_order', { items }),

  getAppSetting: (key: string) => invoke<string | null>('get_app_setting', { key }),
  setAppSetting: (key: string, value: string) => invoke<void>('set_app_setting', { key, value }),

  getTrackLyrics: (trackId: number) => invoke<string | null>('get_track_lyrics', { trackId }),
  setTrackLyrics: (trackId: number, lyrics: string) => invoke<void>('set_track_lyrics', { trackId, lyrics }),

  getLyricsOverride: (trackId: number) =>
    invoke<LyricsOverride | null>('get_lyrics_override', { trackId }),
  setLyricsOverride: (payload: {
    trackId: number
    provider: string
    sourceArtist: string | null
    sourceTitle: string | null
    lrc: string
    offsetMs: number
  }) => invoke<void>('set_lyrics_override', payload),
  /** False when nothing is pinned yet - pin first, then the offset has a home. */
  setLyricsOverrideOffset: (trackId: number, offsetMs: number) =>
    invoke<boolean>('set_lyrics_override_offset', { trackId, offsetMs }),
  clearLyricsOverride: (trackId: number) => invoke<void>('clear_lyrics_override', { trackId }),

  discordSetPresence: (payload: {
    clientId: string
    details: string
    state: string | null
    startMs: number | null
    endMs: number | null
    largeImage: string | null
    smallImage: string | null
  }) => invoke<void>('discord_set_presence', payload),
  discordClearPresence: () => invoke<void>('discord_clear_presence'),

  toggleFavoriteArtist: (artistId: number) => invoke<boolean>('toggle_favorite_artist', { artistId }),
  listFavoriteArtists: () => invoke<Artist[]>('list_favorite_artists'),
  isFavoriteArtist: (artistId: number) => invoke<boolean>('is_favorite_artist', { artistId }),

  toggleFavoriteAlbum: (albumId: number) => invoke<boolean>('toggle_favorite_album', { albumId }),
  listFavoriteAlbums: () => invoke<Album[]>('list_favorite_albums'),
  isFavoriteAlbum: (albumId: number) => invoke<boolean>('is_favorite_album', { albumId }),

  importArtistImage: (artistId: number, path: string) =>
    invoke<void>('import_artist_image', { artistId, path }),

  hideTrack: (trackId: number) => invoke<string>('hide_track', { trackId }),
  unhideTrack: (path: string) => invoke<boolean>('unhide_track', { path }),
  listHiddenTracks: () => invoke<HiddenTrack[]>('list_hidden_tracks'),
  /** Opens the OS file manager with the file selected. False when it has moved. */
  revealInFileManager: (path: string) => invoke<boolean>('reveal_in_file_manager', { path }),

  exportPlaylistM3u8: (playlistId: number, path: string) =>
    invoke<number>('export_playlist_m3u8', { playlistId, path }),
  importPlaylistM3u8: (path: string, name: string) =>
    invoke<Playlist>('import_playlist_m3u8', { path, name }),

  importFont: (path: string) => invoke<string>('import_font', { path }),
  importBackground: (path: string) => invoke<string>('import_background', { path }),
  importAvatar: (path: string) => invoke<string>('import_avatar', { path }),

  getDailyMinutes: (days: number) => invoke<DailyMinutes[]>('get_daily_minutes', { days }),

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
  upsertScTrack: (track: Omit<ScTrack, 'permalinkUrl' | 'streamable' | 'hasProgressive' | 'hasHls'> & Partial<Pick<ScTrack, 'permalinkUrl' | 'streamable' | 'hasProgressive' | 'hasHls'>>) =>
    invoke<number>('sc_upsert_track', { track }),
  fetchOnlineLyricsAll: (artist: string, title: string) =>
    invoke<Array<{ provider: string; plain: string | null; syncedLrc: string | null }>>('fetch_online_lyrics_all', {
      artist,
      title,
    }),
  addScTrackToPlaylist: (playlistId: number, track: ScTrack) =>
    invoke<number>('add_sc_track_to_playlist', { playlistId, track }),
  scCacheInfo: () =>
    invoke<{ path: string; totalBytes: number; fileCount: number; limitBytes: number }>('sc_cache_info'),
  setScCacheDir: (path: string) => invoke<void>('set_sc_cache_dir', { path }),
  clearScCache: () => invoke<void>('clear_sc_cache'),
  setScCacheLimit: (bytes: number) => invoke<void>('sc_set_cache_limit', { bytes }),

  fetchOnlineLyrics: (artist: string, title: string) =>
    invoke<{ plain: string | null; syncedLrc: string | null } | null>('fetch_online_lyrics', {
      artist,
      title,
    }),
}
