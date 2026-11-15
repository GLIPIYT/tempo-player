import { invoke, isTauri } from '@tauri-apps/api/core'
import type { UnifiedTrack } from '../types/models'
import { readBrowserTrackPlaybackPreferences, writeBrowserTrackPlaybackPreferences } from './browserTrackPlaybackPreferences'

export type TrackPlaybackIdentity = Pick<UnifiedTrack, 'source' | 'sourceId'>

export interface TrackPlaybackPreferences {
  volume: number | null
  playbackRate: number | null
  savedVolume: number | null
  savedPlaybackRate: number | null
}

/** A null value disables the override. An omitted field is left as is. */
export type TrackPlaybackPatch = Partial<Pick<TrackPlaybackPreferences, 'volume' | 'playbackRate'>>

export const EMPTY_TRACK_PLAYBACK_PREFERENCES: TrackPlaybackPreferences = {
  volume: null,
  playbackRate: null,
  savedVolume: null,
  savedPlaybackRate: null,
}

export function samePlaybackTrack(a: TrackPlaybackIdentity | null, b: TrackPlaybackIdentity): boolean {
  return a?.source === b.source && a.sourceId === b.sourceId
}

export async function getTrackPlaybackPreferences(identity: TrackPlaybackIdentity): Promise<TrackPlaybackPreferences> {
  const waiting = writes.get(`${identity.source}:${identity.sourceId}`)
  if (waiting) await waiting.catch(() => undefined)
  if (!isTauri()) return readBrowserTrackPlaybackPreferences(identity)
  return invoke<TrackPlaybackPreferences>('get_track_playback_preferences', identity)
}

// Edits to the same track can arrive from a reopened menu while a previous
// edit is in flight. Queue those writes so a late completion cannot undo one.
const writes = new Map<string, Promise<TrackPlaybackPreferences>>()

export function setTrackPlaybackPreferences(identity: TrackPlaybackIdentity, patch: TrackPlaybackPatch): Promise<TrackPlaybackPreferences> {
  const key = `${identity.source}:${identity.sourceId}`
  const save = () => isTauri()
    ? invoke<TrackPlaybackPreferences>('set_track_playback_preferences', { ...identity, patch })
    : writeBrowserTrackPlaybackPreferences(identity, patch)
  const request = Promise.resolve(writes.get(key)).then(save, save).finally(() => {
    if (writes.get(key) === request) writes.delete(key)
  })
  writes.set(key, request)
  return request
}
