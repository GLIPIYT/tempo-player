import { invoke } from '@tauri-apps/api/core'
import { api } from '../../api/client'
import type { ScTrack, Track } from '../../types/models'
import { canPlaySoundCloudTrack } from '../../soundcloud/playability'
import { rememberSoundCloudTrack } from '../../soundcloud/cacheMetadata'
import { acousticAffinity, buildTasteProfile, type TasteProfile } from '../recommendations/profile'
import { recommendationLanguagePreference } from '../recommendations/service'
import { normalizeRecordingText } from '../recommendations/identity'
import { matchesFavoriteGenre, rankGenreTracks } from '../recommendations/genre'
import { generateCustomMix } from './rules'
import type {
  CustomMixCandidate,
  CustomMixGeneratedSelection,
  CustomMixGenerationReason,
  CustomMixRule,
  CustomMixSnapshot,
} from './types'
import { normalizeCustomMixRule } from './types'
import { customMixRuleFingerprint, shouldRegenerateCustomMixSnapshot } from './snapshot'

const PAGE_SIZE = 50
const MAX_GENRE_SEARCHES = 8
const MAX_ARTIST_SEEDS = 2
const MAX_TRACK_SEEDS = 2
const PERSONAL_ACOUSTIC_AFFINITY_MIN = 0.3

let cachedRules: CustomMixRule[] | null = null
const cachedSnapshots = new Map<number, CustomMixSnapshot | null>()

export interface OnlineGenreAugmentationOptions {
  maxGenres?: number
  pageSize?: number
}

export interface OnlineGenreAugmentation {
  candidates: CustomMixCandidate[]
  warnings: string[]
}

export interface GenerateCustomMixSelectionOptions {
  reason: CustomMixGenerationReason
  /** Useful for a forced user refresh; `reason: 'refresh'` is always forced. */
  force?: boolean
  /** Unix seconds, injectable for deterministic tests. */
  now?: number
}

const pendingGenerations = new Map<string, Promise<CustomMixGeneratedSelection>>()

export const listCustomMixRules = async (): Promise<CustomMixRule[]> => {
  const rules = (await invoke<CustomMixRule[]>('list_custom_mix_rules')).map(normalizeCustomMixRule)
  rememberCustomMixRules(rules)
  return rules.map(normalizeCustomMixRule)
}

export const saveCustomMixRule = async (rule: CustomMixRule): Promise<CustomMixRule> => {
  const saved = normalizeCustomMixRule(await invoke<CustomMixRule>('save_custom_mix_rule', { rule: normalizeCustomMixRule(rule) }))
  const rules = (cachedRules ?? []).filter((current) => current.id !== saved.id)
  rules.unshift(saved)
  rememberCustomMixRules(rules)
  return normalizeCustomMixRule(saved)
}

export const deleteCustomMixRule = async (ruleId: number): Promise<void> => {
  await invoke<void>('delete_custom_mix_rule', { ruleId })
  cachedRules = cachedRules?.filter((rule) => rule.id !== ruleId) ?? null
  cachedSnapshots.delete(ruleId)
}

export const getCustomMixCandidates = (): Promise<CustomMixCandidate[]> =>
  invoke<CustomMixCandidate[]>('get_custom_mix_candidates')

export async function getCustomMixSnapshot(ruleId: number): Promise<CustomMixSnapshot | null> {
  if (cachedSnapshots.has(ruleId)) return cloneSnapshot(cachedSnapshots.get(ruleId) ?? null)
  const snapshot = await invoke<CustomMixSnapshot | null>('get_custom_mix_snapshot', { ruleId })
  cachedSnapshots.set(ruleId, cloneSnapshot(snapshot))
  return cloneSnapshot(snapshot)
}

/**
 * Read a still-valid persisted selection without loading the candidate library.
 * Interval-zero mixes intentionally stay on the normal open-and-regenerate path.
 */
export async function getReusableCustomMixSnapshot(
  rawRule: CustomMixRule,
  nowSeconds = Date.now() / 1000,
): Promise<CustomMixGeneratedSelection | null> {
  const rule = normalizeCustomMixRule(rawRule)
  if (rule.id == null || rule.refreshIntervalMinutes <= 0) return null

  let saved: CustomMixSnapshot | null
  try {
    saved = await getCustomMixSnapshot(rule.id)
  } catch {
    return null
  }
  if (!saved || !Array.isArray(saved.tracks) || saved.tracks.length === 0
    || !Array.isArray(saved.warnings)
    || shouldRegenerateCustomMixSnapshot(rule, saved, 'open', nowSeconds)) return null
  return { tracks: saved.tracks, warnings: saved.warnings, generatedAt: saved.generatedAt, fromCache: true }
}

/** Return a rule-matching saved selection for immediate display, even when its cadence is due. */
export async function getDisplayableCustomMixSnapshot(
  rawRule: CustomMixRule,
): Promise<CustomMixGeneratedSelection | null> {
  const rule = normalizeCustomMixRule(rawRule)
  if (rule.id == null) return null
  const snapshot = await getCustomMixSnapshot(rule.id)
  if (!isDisplayableSnapshot(rule, snapshot)) return null
  return rememberSnapshot(rule, snapshot!)
}

export interface CustomMixMemoryState {
  rules: CustomMixRule[]
  selections: { ruleId: number; fingerprint: string; selection: CustomMixGeneratedSelection }[]
}

/** A warm, process-local view for returning to Home while disk refresh runs. */
export function getCustomMixMemoryState(): CustomMixMemoryState {
  const rules = (cachedRules ?? []).map(normalizeCustomMixRule)
  const selections = rules.flatMap((rule) => {
    if (rule.id == null) return []
    const snapshot = cachedSnapshots.get(rule.id)
    if (!isDisplayableSnapshot(rule, snapshot)) return []
    return [{ ruleId: rule.id, fingerprint: customMixRuleFingerprint(rule), selection: selectionFromSnapshot(snapshot!) }]
  })
  return { rules, selections }
}

export const saveCustomMixSnapshot = async (ruleId: number, snapshot: CustomMixSnapshot): Promise<void> => {
  await invoke<void>('save_custom_mix_snapshot', { ruleId, snapshot })
  cachedSnapshots.set(ruleId, cloneSnapshot(snapshot))
}

function cloneSnapshot(snapshot: CustomMixSnapshot | null): CustomMixSnapshot | null {
  if (!snapshot) return null
  return { ...snapshot, tracks: snapshot.tracks.map((track) => ({ ...track })), warnings: [...snapshot.warnings] }
}

function isDisplayableSnapshot(
  rule: CustomMixRule,
  snapshot: CustomMixSnapshot | null | undefined,
): snapshot is CustomMixSnapshot {
  return rule.id != null && Boolean(snapshot) && Array.isArray(snapshot!.tracks) && snapshot!.tracks.length > 0
    && Array.isArray(snapshot!.warnings) && Number.isFinite(snapshot!.generatedAt)
    && snapshot!.ruleFingerprint === customMixRuleFingerprint(rule)
}

function selectionFromSnapshot(snapshot: CustomMixSnapshot): CustomMixGeneratedSelection {
  return { tracks: snapshot.tracks.map((track) => ({ ...track })), warnings: [...snapshot.warnings],
    generatedAt: snapshot.generatedAt, fromCache: true }
}

function rememberSnapshot(rule: CustomMixRule, snapshot: CustomMixSnapshot): CustomMixGeneratedSelection {
  if (rule.id != null) cachedSnapshots.set(rule.id, cloneSnapshot(snapshot))
  return selectionFromSnapshot(snapshot)
}

function rememberCustomMixRules(rules: readonly CustomMixRule[]): void {
  cachedRules = rules.map(normalizeCustomMixRule)
  const current = new Map(cachedRules.flatMap((rule) => rule.id == null ? [] : [[rule.id, rule] as const]))
  for (const [id, snapshot] of cachedSnapshots) {
    const rule = current.get(id)
    if (!rule || !isDisplayableSnapshot(rule, snapshot)) cachedSnapshots.delete(id)
  }
}

async function generateCustomMixSelectionNow(
  rawRule: CustomMixRule,
  libraryCandidates: readonly CustomMixCandidate[],
  options: GenerateCustomMixSelectionOptions,
): Promise<CustomMixGeneratedSelection> {
  const rule = normalizeCustomMixRule(rawRule)
  const now = Math.floor(options.now ?? Date.now() / 1000)
  let saved: CustomMixSnapshot | null = null
  if (rule.id != null) {
    try {
      saved = await getCustomMixSnapshot(rule.id)
    } catch {
      // A snapshot-store error must not prevent a fresh in-memory mix.
    }
  }
  if (saved && !options.force && !shouldRegenerateCustomMixSnapshot(rule, saved, options.reason, now)) {
    return { tracks: saved.tracks, warnings: saved.warnings, generatedAt: saved.generatedAt, fromCache: true }
  }

  let online: OnlineGenreAugmentation = { candidates: [], warnings: [] }
  if (rule.specials.includes('onlineGenre')) {
    online = await augmentOnlineGenreCandidates(rule, libraryCandidates)
  }
  const generated = generateCustomMix(rule, [...libraryCandidates, ...online.candidates], {
    limit: rule.trackCount,
    now,
  })
  const warnings = [...new Set([...generated.warnings, ...online.warnings])]
  const result: CustomMixGeneratedSelection = {
    tracks: generated.tracks,
    warnings,
    generatedAt: now,
    fromCache: false,
  }

  // Empty provider failures must never replace a previously useful snapshot.
  if (generated.tracks.length > 0 && rule.id != null) {
    const next: CustomMixSnapshot = {
      ruleFingerprint: customMixRuleFingerprint(rule),
      generatedAt: now,
      tracks: generated.tracks,
      warnings,
    }
    try {
      await saveCustomMixSnapshot(rule.id, next)
    } catch {
      result.warnings = [...result.warnings, 'This selection could not be saved for the next time you open it.']
    }
  } else if (generated.tracks.length === 0 && saved?.tracks.length
    && saved.ruleFingerprint === customMixRuleFingerprint(rule)) {
    return {
      tracks: saved.tracks,
      warnings: [...new Set([...saved.warnings, ...warnings, 'The mix could not be refreshed; its previous selection is still available.'])],
      generatedAt: saved.generatedAt,
      fromCache: true,
    }
  }
  return result
}

export function generateCustomMixSelection(
  rule: CustomMixRule,
  candidates: readonly CustomMixCandidate[],
  options: GenerateCustomMixSelectionOptions,
): Promise<CustomMixGeneratedSelection> {
  const force = options.force || options.reason === 'refresh'
  if (force) return generateCustomMixSelectionNow(rule, candidates, options)
  const key = `${rule.id ?? 'new'}:${customMixRuleFingerprint(rule)}:${options.reason}`
  const pending = pendingGenerations.get(key)
  if (pending) return pending
  const request = generateCustomMixSelectionNow(rule, candidates, options)
  pendingGenerations.set(key, request)
  void request.finally(() => {
    if (pendingGenerations.get(key) === request) pendingGenerations.delete(key)
  }).catch(() => undefined)
  return request
}

export const customMixService = {
  list: listCustomMixRules,
  save: saveCustomMixRule,
  delete: deleteCustomMixRule,
  getCandidates: getCustomMixCandidates,
  getSnapshot: getCustomMixSnapshot,
  getReusableSnapshot: getReusableCustomMixSnapshot,
  getDisplayableSnapshot: getDisplayableCustomMixSnapshot,
  getMemoryState: getCustomMixMemoryState,
  saveSnapshot: saveCustomMixSnapshot,
  generate: generateCustomMixSelection,
  augmentOnlineGenre: augmentOnlineGenreCandidates,
}

/**
 * Fetch bounded, rule-scoped SoundCloud candidates for the onlineGenre option.
 * Results are ephemeral: this code neither caches them nor imports them into the library.
 */
export async function augmentOnlineGenreCandidates(
  rule: CustomMixRule,
  libraryCandidates: readonly CustomMixCandidate[],
  options: OnlineGenreAugmentationOptions = {},
): Promise<OnlineGenreAugmentation> {
  if (!rule.specials.includes('onlineGenre')) return { candidates: [], warnings: [] }
  if (!rule.sources.includes('soundcloud')) {
    return { candidates: [], warnings: ['Online genre results need SoundCloud enabled.'] }
  }
  if (rule.genreMode !== 'allow' || rule.genres.length === 0) {
    return { candidates: [], warnings: ['Online genre results need selected allow-mode genres.'] }
  }
  if (rule.specials.includes('currentHour') || rule.specials.includes('onRepeat') || rule.specials.includes('noSkips')
    || rule.timeWindow[0] !== 0 || rule.timeWindow[1] !== 1440
    || rule.completionPercent[0] !== 0 || rule.completionPercent[1] !== 100
    || (rule.specials.includes('forgotten') && rule.forgottenPercent[0] === 100)) {
    return { candidates: [], warnings: ['Online tracks cannot meet the selected listening-history filters.'] }
  }
  if (!hasLocalGenreQuotaShortage(rule, libraryCandidates)) return { candidates: [], warnings: [] }

  const warnings: string[] = []
  const requestedGenreLimit = options.maxGenres ?? MAX_GENRE_SEARCHES
  const genreLimit = Math.max(1, Math.min(MAX_GENRE_SEARCHES, Math.floor(requestedGenreLimit)))
  const genres = [...new Map(rule.genres.map((genre) => genre.trim()).filter(Boolean)
    .map((genre) => [normalizeName(genre), genre] as const)).values()]
  const selectedGenres = genres.slice(0, genreLimit)
  if (selectedGenres.length < genres.length) {
    warnings.push(`Online search covered ${selectedGenres.length} of ${genres.length} selected genres.`)
  }

  let profile: TasteProfile | null = null
  try {
    const context = await api.getRecommendationContext()
    profile = buildTasteProfile({ ...context, languagePreference: recommendationLanguagePreference() }, Date.now())
  } catch {
    warnings.push('Listening taste could not be loaded; only direct library artist and related-track matches will be included.')
  }

  const pageSize = Math.max(1, Math.min(PAGE_SIZE, Math.floor(options.pageSize ?? PAGE_SIZE)))
  const libraryArtists = buildLibraryArtistIndex(libraryCandidates)
  const artistSeeds = selectLibraryArtistSeeds(rule, libraryCandidates).slice(0, MAX_ARTIST_SEEDS)
  const trackSeeds = selectSoundCloudTrackSeeds(rule, libraryCandidates).slice(0, MAX_TRACK_SEEDS)
  if (!hasTasteEvidence(profile) && artistSeeds.length === 0 && trackSeeds.length === 0) {
    warnings.push('Online search was skipped because no library artist or listening-taste match was available.')
    return { candidates: [], warnings }
  }
  const failures: string[] = []
  const sources: Array<{ genre: string; tracks: ScTrack[]; personal: boolean }> = []
  let hasMoreResults = false

  const genreRequests = selectedGenres.map(async (genre) => {
    const page = await api.scRecommendationGenreSearch(genre, null, pageSize)
    if (page.error) throw new Error(page.error)
    hasMoreResults ||= page.nextCursor !== null
    sources.push({ genre, tracks: rankGenreTracks(page.tracks, genre, profile), personal: false })
  })

  const artistRequests = artistSeeds.map(async (artistName) => {
    const artists = await api.scSearchArtists(artistName, 3, 0)
    const match = artists.find((artist) => normalizeName(artist.username) === normalizeName(artistName))
    if (!match) return
    const tracks = await api.scArtistTracks(match.id, pageSize, 0)
    appendMatchingGenres(sources, tracks, selectedGenres, profile)
  })

  const relatedRequests = trackSeeds.map(async (seed) => {
    const page = await api.scRecommendationPage(seed.track.externalId!, null, pageSize, 'related')
    if (page.error) throw new Error(page.error)
    hasMoreResults ||= page.nextCursor !== null
    appendMatchingGenres(sources, page.tracks, selectedGenres, profile)
  })

  const outcomes = await Promise.allSettled([...genreRequests, ...artistRequests, ...relatedRequests])
  outcomes.forEach((outcome) => {
    if (outcome.status === 'rejected') failures.push(errorMessage(outcome.reason))
  })
  if (failures.length > 0 && failures.length < outcomes.length) {
    warnings.push('Some online searches failed; the mix includes the results that were available.')
  } else if (failures.length > 0) {
    warnings.push('Online recommendations could not be loaded.')
  }
  if (hasMoreResults) warnings.push('Online results were limited to the first page of each search.')

  const seen = new Set<string>()
  const candidates: CustomMixCandidate[] = []
  const personalArtistNames = new Set(artistSeeds.map(normalizeName))
  for (const source of sources) {
    for (const track of source.tracks) {
      if (seen.has(track.id)) continue
      if (!source.personal && !personalArtistNames.has(normalizeName(track.artist))
        && !isArtistOrAcousticMatch(track, profile)) continue
      seen.add(track.id)
      rememberSoundCloudTrack(track)
      candidates.push(toOnlineCandidate(track, source.genre, libraryArtists, rule))
    }
  }
  if (candidates.length === 0 && failures.length === 0) {
    warnings.push(sources.length > 0
      ? 'No online tracks matched your artist or sound similarity history; the local mix is unchanged.'
      : 'No playable online tracks matched the selected genres; the local mix is unchanged.')
  }
  return { candidates, warnings }
}

function appendMatchingGenres(
  sources: Array<{ genre: string; tracks: ScTrack[]; personal: boolean }>,
  tracks: readonly ScTrack[],
  genres: readonly string[],
  profile: TasteProfile | null,
): void {
  for (const genre of genres) {
    const ranked = rankGenreTracks(tracks, genre, profile)
    if (ranked.length > 0) sources.push({ genre, tracks: ranked, personal: true })
  }
}

function hasLocalGenreQuotaShortage(
  rule: CustomMixRule,
  candidates: readonly CustomMixCandidate[],
): boolean {
  const [minimum] = rule.genrePercent
  if (minimum <= 0 || (rule.genrePercent[0] === 0 && rule.genrePercent[1] === 100)) return false
  const local = generateCustomMix(rule, candidates, { limit: rule.trackCount, seed: 'online-genre-capacity' })
  const genres = new Set(rule.genres.map(normalizeName))
  const genreCount = local.tracks.filter((track) => normalizeGenre(track.genre).some((genre) => genres.has(genre))).length
  return genreCount < Math.ceil(rule.trackCount * minimum / 100)
}

function hasTasteEvidence(profile: TasteProfile | null): boolean {
  if (!profile) return false
  return Object.values(profile.artists).some((weight) => weight > 0) || profile.tracks.length > 0
}

function isArtistOrAcousticMatch(track: ScTrack, profile: TasteProfile | null): boolean {
  if (!profile) return false
  const artistKey = normalizeRecordingText(track.metadataArtist ?? track.artist)
  if (artistKey && (profile.artists[artistKey] ?? 0) > 0) return true
  return (acousticAffinity(`soundcloud:${track.id}`, profile) ?? 0) >= PERSONAL_ACOUSTIC_AFFINITY_MIN
}

function normalizeName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase()
}

function normalizeGenre(value: string | null): string[] {
  return value?.split(/[;,|]/u).map(normalizeName).filter(Boolean) ?? []
}

function matchesArtistRule(rule: CustomMixRule, candidate: CustomMixCandidate): boolean {
  const artistId = candidate.track.artistId
  if (rule.artistIds.length === 0) return true
  if (artistId == null) return rule.artistMode === 'deny'
  const selected = rule.artistIds.includes(artistId)
  return rule.artistMode === 'allow' ? selected : !selected
}

function selectLibraryArtistSeeds(
  rule: CustomMixRule,
  candidates: readonly CustomMixCandidate[],
): string[] {
  const bestByArtist = new Map<string, { name: string; score: number }>()
  for (const candidate of candidates) {
    if (!candidate.liked && candidate.track.playCount < 2) continue
    if (!matchesArtistRule(rule, candidate)) continue
    const name = candidate.track.artistName?.trim()
    if (!name) continue
    if (rule.genres.length > 0 && rule.genreMode === 'allow'
      && !rule.genres.some((genre) => normalizeGenre(candidate.track.genre).includes(normalizeName(genre)))) continue
    const key = normalizeName(name)
    const score = Math.max(0, candidate.track.playCount) + (candidate.liked ? 2 : 0)
    const previous = bestByArtist.get(key)
    if (!previous || score > previous.score) bestByArtist.set(key, { name, score })
  }
  return [...bestByArtist.values()].sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .map((artist) => artist.name)
}

function selectSoundCloudTrackSeeds(
  rule: CustomMixRule,
  candidates: readonly CustomMixCandidate[],
): CustomMixCandidate[] {
  return candidates.filter((candidate) => candidate.track.source === 'soundcloud'
    && Boolean(candidate.track.externalId)
    && candidate.metadataTrusted
    && (candidate.liked || candidate.track.playCount >= 2)
    && matchesArtistRule(rule, candidate)
    && (rule.genreMode !== 'deny' || !candidate.track.genre
      || !rule.genres.some((genre) => normalizeName(genre) === normalizeName(candidate.track.genre!))))
    .slice()
    .sort((left, right) => right.track.playCount - left.track.playCount
      || (right.track.lastPlayedAt ?? 0) - (left.track.lastPlayedAt ?? 0)
      || left.track.id - right.track.id)
}

function buildLibraryArtistIndex(candidates: readonly CustomMixCandidate[]): Map<string, number> {
  const ids = new Map<string, number | null>()
  for (const candidate of candidates) {
    const name = candidate.track.artistName?.trim()
    const id = candidate.track.artistId
    if (!name || id == null) continue
    const key = normalizeName(name)
    const previous = ids.get(key)
    ids.set(key, previous === undefined || previous === id ? id : null)
  }
  return new Map([...ids].filter((entry): entry is [string, number] => entry[1] != null))
}

function onlineTrackId(sourceId: string): number {
  if (/^[1-9]\d*$/u.test(sourceId)) {
    const numericId = Number(sourceId)
    if (Number.isSafeInteger(numericId) && numericId > 0) return -numericId
  }
  let hash = 2166136261
  for (const char of sourceId) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return -1 - ((hash >>> 0) % 2_147_483_647)
}

function toOnlineCandidate(
  source: ScTrack,
  queriedGenre: string,
  libraryArtists: ReadonlyMap<string, number>,
  rule: CustomMixRule,
): CustomMixCandidate {
  const artistName = source.artist.trim()
  const genre = source.genre?.trim() && matchesFavoriteGenre(source, queriedGenre)
    ? source.genre.trim()
    : queriedGenre
  const durationSec = Number.isFinite(source.durationMs) && source.durationMs > 0
    ? source.durationMs / 1000 : null
  const artistId = libraryArtists.get(normalizeName(artistName)) ?? null
  const track: Track = {
    id: onlineTrackId(source.id),
    path: `soundcloud://${source.id}`,
    title: source.title,
    artistId,
    artistName,
    albumId: null,
    albumTitle: null,
    trackNumber: null,
    discNumber: null,
    durationSec,
    year: null,
    genre,
    coverPath: source.artworkUrl,
    fileSize: 0,
    modifiedAt: 0,
    addedAt: Math.floor(Date.now() / 1000),
    source: 'soundcloud',
    externalId: source.id,
    lastPlayedAt: null,
    playCount: 0,
    skipCount: 0,
    gainDb: null,
    peakDb: null,
  }
  return {
    track,
    averageCompletionPercent: null,
    historyMinutes: [],
    liked: false,
    metadataTrusted: Boolean(track.title.trim() && artistName && genre && canPlaySoundCloudTrack(source)
      && (rule.artistIds.length === 0 || artistId !== null)),
    origin: 'online',
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
