import { invoke } from '@tauri-apps/api/core'
import { withExplicitFeedback } from '../features/recommendations/feedbackBridge'
import type { AudioRecordingFeature, ExplicitAction, FeatureSectionUpdate, RecommendationProvenance } from '../features/recommendations/types'
import type { ListeningEvent, RecommendationContext, RecommendationFeature, RecommendationImpression, RecommendationProviderPage, RecommendationStoredState, RecordingGroup, RecordingGroupResolution, ScRelatedPage, ScRecommendationSource } from '../features/recommendations/types'
import type {
  Album,
  AlbumDetail,
  AnalyticsData,
  AnalyticsPeriod,
  Artist,
  ArtistDetail,
  ArtistImageCandidate,
  CoversCacheInfo,
  DailyMinutes,
  FavoriteOrderEntry,
  HiddenTrack,
  HistoryEntry,
  LibraryFolder,
  LrclibPublishRequest,
  LyricsOverride,
  OnlineLyricsCandidateData,
  Playlist,
  PlaylistPlayStat,
  PlaylistTrack,
  LibraryElementKind,
  TrackMetadataEditorState,
  TrackMetadataEditRequest,
  TrackMetadataOriginal,
  ScanSummary,
  ScArtist,
  ScPlaylist,
  ScPlaylistDetail,
  ScTrack,
  YtCollectionDetail,
  YtCollectionHit,
  YtEnrichment,
  YtSearchHit,
  YtdlpStatus,
  SearchResults,
  TopTrackItem,
  Track,
} from '../types/models'
import type { LyricsEditorDocument } from '../features/lyrics/editorDocument'
import type {
  BackgroundImageProvider,
  BackgroundProviderStatus,
  BackgroundSearchFilters,
  BackgroundSearchPage,
} from '../types/backgrounds'

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
  listPlaylistCoverPreviews: () => invoke<Record<string, string[]>>('list_playlist_cover_previews'),
  listPlaylistPlayStats: () => invoke<PlaylistPlayStat[]>('list_playlist_play_stats'),
  recordPlaylistStart: (playlistId: number) => invoke<void>('record_playlist_start', { playlistId }),
  getPlaylist: (playlistId: number) => invoke<PlaylistTrack[]>('get_playlist', { playlistId }),
  playlistAddTrack: (playlistId: number, trackId: number) =>
    withExplicitFeedback(() => invoke<void>('playlist_add_track', { playlistId, trackId }),
      { trackKey: `local:${trackId}`, dbId: trackId, playlistId, action: 'playlist-add', intent: 'manual' }),
  playlistRemoveTrack: (playlistId: number, trackId: number) =>
    invoke<void>('playlist_remove_track', { playlistId, trackId }),
  playlistMoveTrack: (playlistId: number, fromPos: number, toPos: number) =>
    invoke<void>('playlist_move_track', { playlistId, fromPos, toPos }),

  bumpPlayCount: (trackId: number) => invoke<void>('bump_play_count', { trackId }),
  recordHistory: (trackId: number, listenedSec: number | null, completed: boolean, skipped: boolean) =>
    invoke<void>('record_history', { trackId, listenedSec, completed, skipped }),

  likeTrack: (trackId: number) => withExplicitFeedback(() => invoke<void>('like_track', { trackId }),
    { trackKey: `local:${trackId}`, dbId: trackId, action: 'like', intent: 'manual' }),
  unlikeTrack: (trackId: number) => withExplicitFeedback(() => invoke<void>('unlike_track', { trackId }),
    { trackKey: `local:${trackId}`, dbId: trackId, action: 'unlike', intent: 'manual' }),
  listLikedTrackIds: () => invoke<number[]>('list_liked_track_ids'),

  getTopTracks: (limit: number) =>
    invoke<TopTrackItem[]>('get_top_tracks', { limit }),
  getDormantTracks: (beforeSecs: number, limit: number) =>
    invoke<Track[]>('get_dormant_tracks', { beforeSecs, limit }),
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

  getTrackMetadataOriginal: (trackId: number) =>
    invoke<TrackMetadataOriginal | null>('get_track_metadata_original', { trackId }),
  getTrackMetadataEditorState: (trackId: number) =>
    invoke<TrackMetadataEditorState>('get_track_metadata_editor_state', { trackId }),
  /** Returns the selected library element's local path or remote image URL without downloading it. */
  getLibraryCover: (kind: LibraryElementKind, id: number) =>
    invoke<string | null>('get_library_cover', { kind, id }),
  updateLocalTrackMetadata: (request: TrackMetadataEditRequest) =>
    invoke<Track>('update_local_track_metadata', { request }),
  restoreTrackMetadata: (trackId: number) =>
    invoke<Track>('restore_track_metadata', { trackId }),

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
  saveLyricsEditorDocument: (payload: {
    trackId: number
    provider: string
    sourceArtist: string | null
    sourceTitle: string | null
    lrc: string
    offsetMs: number
    editorDocument: LyricsEditorDocument
  }) => invoke<void>('save_lyrics_editor_document', payload),
  publishLyricsToLrclib: (request: LrclibPublishRequest) =>
    invoke<number>('publish_lyrics_to_lrclib', { request }),
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
  searchArtistImages: (query: string) =>
    invoke<ArtistImageCandidate[]>('search_artist_images', { query }),
  saveArtistImageFromUrl: (artistId: number, url: string) =>
    invoke<string>('save_artist_image_from_url', { artistId, url }),

  hideTrack: (trackId: number) => invoke<string>('hide_track', { trackId }),
  unhideTrack: (path: string) => invoke<boolean>('unhide_track', { path }),
  listHiddenTracks: () => invoke<HiddenTrack[]>('list_hidden_tracks'),
  /** Opens the OS file manager with the file selected. False when it has moved. */
  revealInFileManager: (path: string) => invoke<boolean>('reveal_in_file_manager', { path }),

  exportPlaylistM3u8: (playlistId: number, path: string) =>
    invoke<number>('export_playlist_m3u8', { playlistId, path }),
  exportTracksM3u8: (trackIds: number[], path: string) =>
    invoke<number>('export_tracks_m3u8', { trackIds, path }),
  importPlaylistM3u8: (path: string, name: string) =>
    withExplicitFeedback(async () => {
      const playlist = await invoke<Playlist>('import_playlist_m3u8', { path, name, manualIntent: true })
      const tracks = await invoke<PlaylistTrack[]>('get_playlist', { playlistId: playlist.id })
      return { playlist, tracks }
    }, result => result.tracks.map(({ track }) => ({ trackKey: `local:${track.id}`, dbId: track.id,
      playlistId: result.playlist.id, action: 'playlist-add', intent: 'manual' }))).then(result => result.playlist),

  importFont: (path: string) => invoke<string>('import_font', { path }),
  importBackground: (path: string) => invoke<string>('import_background', { path }),
  searchBackgrounds: (
    provider: BackgroundImageProvider,
    query: string,
    filters: BackgroundSearchFilters,
  ) => invoke<BackgroundSearchPage>('search_backgrounds', { provider, query, filters }),
  getBackgroundProviderStatus: () =>
    invoke<BackgroundProviderStatus[]>('get_background_provider_status'),
  getBackgroundPreview: (provider: BackgroundImageProvider, imageUrl: string) =>
    invoke<string>('get_background_preview', { provider, imageUrl }),
  saveSelectedBackground: (provider: BackgroundImageProvider, imageUrl: string) =>
    invoke<string>('save_selected_background', { provider, imageUrl }),
  listSavedBackgrounds: () => invoke<string[]>('list_saved_backgrounds'),
  importAvatar: (path: string) => invoke<string>('import_avatar', { path }),

  getDailyMinutes: (days: number) => invoke<DailyMinutes[]>('get_daily_minutes', { days }),

  getAnalytics: (period: AnalyticsPeriod) =>
    invoke<AnalyticsData>('get_analytics', { sinceSecs: periodSinceSecs(period) }),
  clearHistory: async () => {
    await invoke<void>('clear_history')
    window.dispatchEvent(new Event('tempo:listening-history-cleared'))
  },
  recordListeningSession: async (event: ListeningEvent) => {
    await invoke<void>('record_listening_session', { event })
    window.dispatchEvent(new CustomEvent('tempo:listening-feedback', { detail: event }))
  },
  mergeRecommendationFeatureSections: (updates: FeatureSectionUpdate[]) => invoke<RecommendationFeature[]>('merge_recommendation_feature_sections', { updates }),
  getRecommendationAudioFeature: (request: { jobId: string; trackId: number | null; source: string; sourceId: string; durationSec: number | null; versionKey: string }) =>
    invoke<AudioRecordingFeature | null>('recommendation_audio_feature', request),
  cancelRecommendationAudioFeature: (jobId: string) => invoke<void>('cancel_recommendation_audio_feature', { jobId }),
  recordRecommendationAction: (action: { id: string; trackKey: string; dbId?: number; action: string; intent: string; at: number; generation: number; playlistId?: number; provenance?: RecommendationProvenance }) =>
    invoke<ExplicitAction>('record_recommendation_action', action),
  getRecommendationContext: () => invoke<RecommendationContext>('get_recommendation_context'),
  recordRecommendationImpressions: (impressions: RecommendationImpression[], generation: number) => invoke<void>('record_recommendation_impressions', { impressions, generation }),
  saveRecommendationFeatures: (features: RecommendationFeature[]) => invoke<void>('save_recommendation_features', { features }),
  saveRecommendationState: (storedState: RecommendationStoredState, generation: number, expectedRevision?: number) => invoke<void>('save_recommendation_state', { storedState, generation, expectedRevision }),
  getRecommendationPage: (key: string) => invoke<RecommendationProviderPage | null>('get_recommendation_page', { key }),
  saveRecommendationPage: (page: RecommendationProviderPage) => invoke<void>('save_recommendation_page', { page }),
  mergeRecommendationGroups: (groupKeys: string[], trackKeys: string[], generation: number) =>
    invoke<RecordingGroup>('merge_recommendation_groups', { groupKeys, trackKeys, generation }),
  resolveRecommendationGroups: (trackKeys: string[], groupKeys: string[]) =>
    invoke<RecordingGroupResolution[]>('resolve_recommendation_groups', { trackKeys, groupKeys }),
  completeListeningExit: () => invoke<void>('complete_listening_exit'),

  getCoversCacheInfo: () => invoke<CoversCacheInfo>('get_covers_cache_info'),
  clearCoversCache: () => invoke<void>('clear_covers_cache'),
  getHistory: (limit: number, offset: number) =>
    invoke<HistoryEntry[]>('get_history', { limit, offset }),

  setTaskbarProgress: (position: number, duration: number, playing: boolean) =>
    invoke<void>('set_taskbar_progress', { position, duration, playing }),

  setCloseToTray: (enabled: boolean) => invoke<void>('set_close_to_tray', { enabled }),

  setTrayLabels: (labels: {
    show: string
    toggle: string
    prev: string
    next: string
    quit: string
  }) => invoke<void>('set_tray_labels', labels),

  listTracksNeedingLoudness: (limit: number) =>
    invoke<{ id: number; path: string }[]>('list_tracks_needing_loudness', { limit }),

  countTracksNeedingLoudness: () => invoke<number>('count_tracks_needing_loudness'),

  setTrackLoudness: (trackId: number, gainDb: number | null, peakDb: number | null) =>
    invoke<void>('set_track_loudness', { trackId, gainDb, peakDb }),

  scSearchTracks: (query: string, limit: number, offset: number) =>
    invoke<ScTrack[]>('sc_search_tracks', { query, limit, offset }),

  scSearchPlaylists: (query: string, limit: number, offset: number) =>
    invoke<ScPlaylist[]>('sc_search_playlists', { query, limit, offset }),

  scSearchArtists: (query: string, limit: number, offset: number) =>
    invoke<ScArtist[]>('sc_search_artists', { query, limit, offset }),

  scRelatedTracks: (seedIds: string[], limit: number) =>
    invoke<ScTrack[]>('sc_related_tracks', { seedIds, limit }),
  scRecommendationPage: (seedId: string, cursor: string | null, limit: number, source: ScRecommendationSource) =>
    invoke<ScRelatedPage>('sc_recommendation_page', { seedId, cursor, limit, source }),
  scRecommendationSearch: (query: string, limit: number) => invoke<ScRelatedPage>('sc_recommendation_search', { query, limit }),
  scRecommendationGenreSearch: (genre: string, limit: number) =>
    invoke<ScRelatedPage>('sc_recommendation_genre_search', { genre, limit }),

  /** Cache-only status lookup; it never resolves stream URLs or starts downloads. */
  scGetCachedTrackIds: (trackIds: string[]) =>
    invoke<string[]>('sc_get_cached_track_ids', { trackIds }),

  // Read straight from SoundCloud; nothing is written to the library, which is
  // what lets a playlist or artist be browsed before deciding to keep it.
  scGetPlaylist: (id: string) => invoke<ScPlaylistDetail>('sc_get_playlist', { id }),

  scGetArtist: (id: string) => invoke<ScArtist>('sc_get_artist', { id }),

  scArtistTracks: (id: string, limit: number, offset: number) =>
    invoke<ScTrack[]>('sc_artist_tracks', { id, limit, offset }),

  scArtistPlaylists: (id: string, limit: number, offset: number) =>
    invoke<ScPlaylist[]>('sc_artist_playlists', { id, limit, offset }),

  /** An artist's releases with their tracks, for bringing the albums along. */
  scArtistReleases: (id: string) => invoke<ScPlaylistDetail[]>('sc_artist_releases', { id }),

  scImportArtist: (
    name: string,
    avatarUrl: string | null,
    tracks: ScTrack[],
    albumOf: Record<string, string>,
    mergeInto: number | null,
  ) => invoke<number>('sc_import_artist', { name, avatarUrl, tracks, albumOf, mergeInto }),

  /** Files an explicitly cached SoundCloud track under its uploader. */
  scImportTrack: (track: ScTrack) => invoke<number>('sc_import_track', { track }),

  // yt-dlp. The binary path is passed in on every call rather than read in
  // Rust, so settings stay the single source of truth for it.
  ytdlpStatus: (configured: string) => invoke<YtdlpStatus>('ytdlp_status', { configured }),

  /** Fetches the app's own copy, or refreshes it when GitHub has a newer one. */
  ytdlpEnsure: (configured: string) => invoke<YtdlpStatus>('ytdlp_ensure', { configured }),

  ytdlpSearch: (configured: string, query: string, limit: number) =>
    invoke<YtSearchHit[]>('ytdlp_search', { configured, query, limit }),

  ytdlpCache: (configured: string, url: string, key: string) =>
    invoke<string>('ytdlp_cache', { configured, url, key }),

  /**
   * Resolves the artist, album and duration a flat search cannot provide.
   *
   * Returns as soon as the work starts; results arrive one at a time on
   * `ytdlp://enriched`, because a batch would leave the list blank for half a
   * minute.
   */
  ytdlpEnrich: (configured: string, jobId: string, ids: string[]) =>
    invoke<void>('ytdlp_enrich', { configured, jobId, ids }),

  ytdlpEnrichCancel: (jobId: string) => invoke<void>('ytdlp_enrich_cancel', { jobId }),

  /** Albums, artists or playlists - which come back as ids with no name. */
  ytdlpSearchCollections: (configured: string, query: string, limit: number, section: string) =>
    invoke<YtCollectionHit[]>('ytdlp_search_collections', { configured, query, limit, section }),

  /**
   * The library row a saved collection was filed under.
   *
   * Favourites are kept against the library's own rows, so a collection can
   * only be favourited once it has been saved - and this is how the page finds
   * out that it has, and under what.
   */
  findYtCollectionRow: (kind: string, name: string, artist: string) =>
    invoke<number | null>('find_yt_collection_row', { kind, name, artist }),

  /** Opens an album, artist or playlist for preview. */
  ytdlpOpenCollection: (configured: string, url: string) =>
    invoke<YtCollectionDetail>('ytdlp_open_collection', { configured, url }),

  /** Resolves collection metadata and streams each result on `ytdlp://browsed`. */
  ytdlpBrowse: (configured: string, jobId: string, hits: YtCollectionHit[]) =>
    invoke<void>('ytdlp_browse', { configured, jobId, hits }),

  /**
   * Resolves one track's metadata, so the player can file it under the right
   * artist and album without waiting for the search to reach that far down the
   * list.
   */
  ytdlpResolveOne: (configured: string, videoId: string) =>
    invoke<YtEnrichment | null>('ytdlp_resolve_one', { configured, videoId }),

  /** Files a played YouTube track, with the artist and album it came from. */
  upsertYtTrack: (payload: {
    videoId: string
    title: string
    artist: string
    album: string
    durationMs: number
    artworkUrl: string | null
    cachedPath: string | null
  }) => invoke<number>('upsert_yt_track', payload),

  scGetPlayback: (trackId: string, waitForCache = false, permalinkUrl: string | null = null,
    configured = '', forceYtdlp = false) =>
    invoke<{ url: string | null; cachedPath: string | null; format: string | null }>('sc_get_playback', {
      trackId,
      permalinkUrl,
      configured,
      forceYtdlp,
      waitForCache,
    }),

  /** Fetches a track ahead of playback and files it once the cache is ready. */
  scPrecache: (track: Pick<ScTrack, 'id' | 'title' | 'artist' | 'durationMs' | 'artworkUrl'> & Partial<Pick<ScTrack, 'artistAvatarUrl' | 'permalinkUrl'>>) =>
    invoke<void>('sc_precache', { track }),
  upsertScTrack: (track: Omit<ScTrack, 'artistAvatarUrl' | 'permalinkUrl' | 'streamable' | 'hasProgressive' | 'hasHls'> & Partial<Pick<ScTrack, 'artistAvatarUrl' | 'permalinkUrl' | 'streamable' | 'hasProgressive' | 'hasHls'>>) =>
    invoke<number>('sc_upsert_track', { track }),
  fetchOnlineLyricsAll: (
    artist: string,
    title: string,
    album: string | null = null,
    durationSec: number | null = null,
  ) => invoke<OnlineLyricsCandidateData[]>('fetch_online_lyrics_all', { artist, title, album, durationSec }),
  addScTrackToPlaylist: (playlistId: number, track: ScTrack) =>
    withExplicitFeedback(() => invoke<number>('add_sc_track_to_playlist', { playlistId, track }),
      dbId => ({ trackKey: `soundcloud:${track.id}`, dbId, playlistId, action: 'playlist-add', intent: 'manual' })),
  scCacheInfo: () =>
    invoke<{ path: string; totalBytes: number; fileCount: number; limitBytes: number }>('sc_cache_info'),
  setScCacheDir: (path: string) => invoke<void>('set_sc_cache_dir', { path }),
  clearScCache: async () => {
    await invoke<void>('clear_sc_cache')
    window.dispatchEvent(new Event('tempo:soundcloud-cache-invalidated'))
  },
  setScCacheLimit: (bytes: number) => invoke<void>('sc_set_cache_limit', { bytes }),

  fetchOnlineLyrics: (
    artist: string,
    title: string,
    album: string | null = null,
    durationSec: number | null = null,
  ) =>
    invoke<{ plain: string | null; syncedLrc: string | null; copyright: string | null } | null>('fetch_online_lyrics', {
      artist,
      title,
      album,
      durationSec,
    }),
}
