import type {
  TrackPlaybackIdentity,
  TrackPlaybackPatch,
  TrackPlaybackPreferences,
} from './trackPlaybackPreferences'

const EMPTY: TrackPlaybackPreferences = Object.freeze({
  volume: null,
  playbackRate: null,
  savedVolume: null,
  savedPlaybackRate: null,
})

function storageKey(track: TrackPlaybackIdentity): string {
  return `tempo.trackPlayback.v1:${track.source}:${track.sourceId}`
}

function volumeValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : null
}

function rateValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.min(2, Math.max(0.5, value)) * 20) / 20
    : null
}

export function readBrowserTrackPlaybackPreferences(track: TrackPlaybackIdentity | null): TrackPlaybackPreferences {
  if (!track) return EMPTY
  try {
    const raw = window.localStorage.getItem(storageKey(track))
    if (!raw) return EMPTY
    const stored: Partial<TrackPlaybackPreferences> | null = JSON.parse(raw)
    if (!stored || typeof stored !== 'object') return EMPTY
    const volume = volumeValue(stored.volume)
    const playbackRate = rateValue(stored.playbackRate)
    return {
      volume,
      playbackRate,
      savedVolume: volume ?? volumeValue(stored.savedVolume),
      savedPlaybackRate: playbackRate ?? rateValue(stored.savedPlaybackRate),
    }
  } catch {
    return EMPTY
  }
}

export function writeBrowserTrackPlaybackPreferences(
  track: TrackPlaybackIdentity,
  patch: TrackPlaybackPatch,
): TrackPlaybackPreferences {
  const current = readBrowserTrackPlaybackPreferences(track)
  const volume = patch.volume === undefined ? current.volume : volumeValue(patch.volume)
  const playbackRate = patch.playbackRate === undefined ? current.playbackRate : rateValue(patch.playbackRate)
  if ((patch.volume != null && volume === null) || (patch.playbackRate != null && playbackRate === null)) {
    throw new Error('Invalid track playback preferences')
  }
  if (volume === current.volume && playbackRate === current.playbackRate) return current
  const next = {
    volume,
    playbackRate,
    savedVolume: volume ?? current.savedVolume,
    savedPlaybackRate: playbackRate ?? current.savedPlaybackRate,
  }
  window.localStorage.setItem(storageKey(track), JSON.stringify(next))
  return next
}
