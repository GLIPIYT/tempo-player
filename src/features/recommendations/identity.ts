import type { ScTrack } from '../../types/models'
import type { RecordingIdentity } from './types'

export const RECORDING_FEATURE_VERSION = 1

/** Matching only: original provider/display metadata is never mutated. */
export function normalizeRecordingText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[\u2010-\u2015\u2212]/gu, '-')
    .replace(/[\u2018\u2019\u201a\u201b]/gu, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/gu, '"')
    .replace(/\s+/gu, ' ').trim()
}

const versionToken = /\b(?:remix|live|slowed|sped[ -]?up|cover|instrumental|acoustic|edit)\b/iu
const noise = /\s*[([]\s*(?:official (?:audio|video|music video)|lyrics?(?: video)?|hq|hd|free download)\s*[)\]]/giu
const genericTitles = new Set(['intro', 'outro', 'untitled', 'track', 'song', 'demo', 'test', 'unknown'])

export function recordingIdentity(track: ScTrack, knownArtists: Iterable<string> = []): RecordingIdentity {
  const known = new Set(Array.from(knownArtists, normalizeRecordingText).filter(Boolean))
  let title = normalizeRecordingText(track.title).replace(noise, '').trim()
  const metadata = normalizeRecordingText(track.metadataArtist ?? '')
  let artist: string | null = metadata || null
  let artistConfidence = artist ? 1 : 0
  const split = title.match(/^(.+?)\s+-\s+(.+)$/u)
  if (split) {
    const prefix = split[1].trim()
    if ((metadata && prefix === metadata) || (!metadata && known.has(prefix))) {
      artist = prefix
      artistConfidence = metadata ? 1 : 0.9
      title = split[2].trim()
    }
  }
  // A uploader name alone is never evidence that this is the recording artist.
  const versions: string[] = []
  title = title.replace(/[([]([^()[\]]+)[)\]]/gu, (whole, contents: string) => {
    if (!versionToken.test(contents)) return whole
    versions.push(contents.trim())
    return ' '
  })
  const suffix = title.match(/\s+-\s+(.+)$/u)
  if (suffix && versionToken.test(suffix[1])) {
    versions.push(suffix[1].trim())
    title = title.slice(0, suffix.index).trim()
  }
  // Unbracketed version names stay in the title and also guard version equality.
  const unbracketed = title.match(/\b(?:remix|live|slowed|sped[ -]?up|cover|instrumental|acoustic|edit)\b/giu)
  // Keep placement distinct: a song named "Live Forever" is not its "(live)" upload.
  if (unbracketed) versions.push(...unbracketed.map(token => `title:${token}`))
  title = title.replace(/\s+/gu, ' ').trim()
  const version = Array.from(new Set(versions.map(value => value.replace(/\bsped[ -]?up\b/gu, 'sped up')))).sort().join(' | ') || 'original'
  const compactTitle = title.replace(/[^\p{L}\p{N}]/gu, '')
  // Numbering/punctuation cannot turn Intro 01, Untitled-1 or Demo #2 into specific titles.
  const genericLabel = compactTitle.replace(/\p{N}/gu, '')
  const specificTitle = compactTitle.length >= 5
    && /\p{L}/u.test(title) && !genericTitles.has(genericLabel)
  const rawIsrc = (track.isrc ?? '').replace(/[\s-]/gu, '').toUpperCase()
  const isrc = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/u.test(rawIsrc) ? rawIsrc : null
  const durationSec = Number.isFinite(track.durationMs) && track.durationMs > 0 ? track.durationMs / 1000 : null
  const trackKey = `soundcloud:${track.id}`
  return {
    featureVersion: RECORDING_FEATURE_VERSION, trackKey, originalTitle: track.title,
    title, artist, artistConfidence,
    confidence: artist ? (specificTitle ? artistConfidence : artistConfidence * 0.5) : 0.2,
    uploaderId: track.uploaderId ?? null, uploaderName: track.uploaderName ?? track.artist ?? null,
    durationSec, version, isrc, specificTitle,
    familyKey: JSON.stringify([artist, title, version]),
    // Stable until a persisted alias merge: do not use rounded duration as identity.
    groupKey: trackKey,
  }
}

/** >= .95 is safe for automatic grouping; weaker values are ranking evidence. */
export function duplicateConfidence(a: RecordingIdentity, b: RecordingIdentity): number {
  if (a.trackKey === b.trackKey) return 1
  if (a.version !== b.version) return 0
  if (a.isrc && b.isrc && a.isrc !== b.isrc) return 0
  if (a.title !== b.title) return 0
  const durationMatches = a.durationSec !== null && b.durationSec !== null
    && a.durationSec > 0 && b.durationSec > 0
    && Math.abs(a.durationSec - b.durationSec) <= Math.max(2, Math.min(a.durationSec, b.durationSec) * 0.01)
  const artistMatches = a.artist !== null && a.artist === b.artist
    && Math.min(a.artistConfidence, b.artistConfidence) >= 0.9
  const independentEvidence = a.isrc !== null && a.isrc === b.isrc
  if (durationMatches && artistMatches && ((a.specificTitle && b.specificTitle) || independentEvidence)) return 0.97
  return artistMatches ? 0.55 : 0.25
}

export function chooseRepresentative(group: readonly ScTrack[]): ScTrack {
  if (!group.length) throw new Error('Cannot choose a representative of an empty recording group')
  const score = (track: ScTrack) => (track.streamable && (track.hasProgressive || track.hasHls) ? 100 : 0)
    + recordingIdentity(track).confidence * 10 + (track.isrc ? 2 : 0)
    + (track.hasProgressive ? 0.5 : 0) + (track.artworkUrl ? 0.1 : 0)
  return group.reduce((best, track) => score(track) > score(best) ? track : best)
}
