import type { Album, Artist, UnifiedTrack } from '../types/models'

export interface ProviderCapabilities {
  search: boolean
  metadata: boolean
  playback: boolean
  lyrics: boolean
  recommendations: boolean
}

export type SearchHit =
  | { kind: 'track'; track: UnifiedTrack }
  | { kind: 'album'; album: Album }
  | { kind: 'artist'; artist: Artist }

export interface MusicProvider {
  id: string
  name: string
  capabilities: ProviderCapabilities
  search(query: string): Promise<SearchHit[]>
  getTrack?(id: string): Promise<UnifiedTrack>
  getArtist?(id: string): Promise<Artist>
  getAlbum?(id: string): Promise<Album>
}
