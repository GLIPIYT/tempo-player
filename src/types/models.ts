export type SourceId = 'local' | 'soundcloud'

export interface ScTrack {
  id: string
  title: string
  artist: string
  durationMs: number
  artworkUrl: string | null
  permalinkUrl: string | null
  streamable: boolean
  hasProgressive: boolean
  hasHls: boolean
}

export interface LibraryFolder {
  id: number
  path: string
  enabled: boolean
  addedAt: number
  trackCount?: number
}

export interface Artist {
  id: number
  name: string
  albumCount?: number
  trackCount?: number
}

export interface Album {
  id: number
  title: string
  artistId: number | null
  artistName?: string | null
  year: number | null
  coverPath: string | null
  trackCount?: number
}

export interface Track {
  id: number
  path: string
  title: string
  artistId: number | null
  artistName: string | null
  albumId: number | null
  albumTitle: string | null
  trackNumber: number | null
  discNumber: number | null
  durationSec: number | null
  year: number | null
  genre: string | null
  coverPath: string | null
  fileSize: number
  modifiedAt: number
  addedAt: number
  source: SourceId
  externalId: string | null
  lastPlayedAt: number | null
  playCount: number
  skipCount: number
}

export interface Playlist {
  id: number
  name: string
  createdAt: number
  updatedAt: number
  trackCount?: number
  pinned?: boolean
  pinOrder?: number | null
}

export interface PlaylistTrack {
  position: number
  addedAt: number
  track: Track
}

export interface AlbumDetail {
  album: Album
  tracks: Track[]
}

export interface ArtistDetail {
  artist: Artist
  albums: Album[]
}

export interface SearchResults {
  tracks: Track[]
  albums: Album[]
  artists: Artist[]
}

export type RepeatMode = 'off' | 'all' | 'one'

export type ScanPhase = 'started' | 'progress' | 'completed'

export interface ScanProgress {
  phase: ScanPhase
  scannedFiles: number
  added: number
  updated: number
  removed: number
  unchanged: number
  errors: number
  currentFile: string | null
}

export interface ScanSummary {
  scannedFiles: number
  added: number
  updated: number
  removed: number
  unchanged: number
  errors: number
  durationMs: number
}

export interface UnifiedTrack {
  source: SourceId
  sourceId: string
  dbId: number | null
  title: string
  artists: string[]
  album: string | null
  durationSec: number | null
  coverPath: string | null
  playable: boolean
  localPath: string | null
  externalUrl: string | null
}

export interface HistoryEntry {
  id: number
  trackId: number
  playedAt: number
  startSec: number | null
  listenedSec: number | null
  completed: boolean
  skipped: boolean
  track: Track
}

export interface StatsSummary {
  totalMinutes: number
  plays: number
  uniqueArtists: number
  avgCompletionPct: number
}

export interface TopTrackItem {
  track: Track
  playCount: number
}

export interface TopArtistItem {
  artist: Artist
  playCount: number
}

export type AnalyticsPeriod = 'today' | '7d' | '30d' | 'all'

export interface AnalyticsData {
  summary: StatsSummary
  topTracks: TopTrackItem[]
  topArtists: TopArtistItem[]
  recent: HistoryEntry[]
}

export interface CoversCacheInfo {
  path: string
  totalBytes: number
  fileCount: number
}
