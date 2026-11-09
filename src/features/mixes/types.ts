import type { SourceId, Track } from '../../types/models'

export type MixArtistMode = 'allow' | 'deny'
export type MixGenreMode = 'allow' | 'deny'
export type MixSpecial = 'currentHour' | 'onlineGenre' | 'forgotten' | 'onRepeat' | 'newToYou' | 'noSkips'
export type PercentRange = [number, number]
export type MinuteRange = [number, number]
export type ForgottenDaysRange = [number, number]

/** A saved custom mix rule. Empty filter lists mean that filter is inactive. */
export interface CustomMixRule {
  id: number | null
  name: string
  description: string
  trackCount: number
  refreshIntervalMinutes: number
  artistMode: MixArtistMode
  artistIds: number[]
  timeWindow: MinuteRange
  completionPercent: PercentRange
  genreMode: MixGenreMode
  genres: string[]
  genrePercent: PercentRange
  sources: SourceId[]
  specials: MixSpecial[]
  forgottenPercent: PercentRange
  forgottenDays: ForgottenDaysRange
}

/** Track facts used by the rule engine. History minutes use the computer's local clock. */
export interface CustomMixCandidate {
  track: Track
  averageCompletionPercent: number | null
  historyMinutes: number[]
  liked: boolean
  /** Online candidates participate only when the provider metadata is trusted. */
  metadataTrusted: boolean
  /** Marks an ephemeral provider result so genre searches stay scoped to their query. */
  origin?: 'online'
}

export interface CustomMixGenerationOptions {
  /** Unix seconds for deterministic tests; Date uses the local machine's current clock. */
  now?: Date | number
  /** Supplying a seed makes the selection repeatable. Omitted seeds are fresh per generation. */
  seed?: number | string
  /** Output count, capped at 50. Defaults to 24. */
  limit?: number
}

export interface CustomMixGenerationResult {
  tracks: Track[]
  warnings: string[]
  requestedCount: number
  actualCount: number
}

export interface CustomMixSnapshot {
  ruleFingerprint: string
  /** Unix seconds. */
  generatedAt: number
  tracks: Track[]
  warnings: string[]
}

export type CustomMixGenerationReason = 'open' | 'refresh' | 'scheduled'

export interface CustomMixGeneratedSelection {
  tracks: Track[]
  warnings: string[]
  /** Unix seconds. */
  generatedAt: number
  fromCache: boolean
}

export const DEFAULT_CUSTOM_MIX_RULE: Omit<CustomMixRule, 'id' | 'name'> = {
  description: '',
  trackCount: 24,
  refreshIntervalMinutes: 0,
  artistMode: 'allow',
  artistIds: [],
  timeWindow: [0, 1440],
  completionPercent: [0, 100],
  genreMode: 'allow',
  genres: [],
  genrePercent: [0, 100],
  sources: ['local', 'soundcloud', 'youtube'],
  specials: [],
  forgottenPercent: [0, 100],
  forgottenDays: [1, 365],
}

export function createCustomMixRule(name = ''): CustomMixRule {
  return { id: null, name, ...DEFAULT_CUSTOM_MIX_RULE,
    timeWindow: [...DEFAULT_CUSTOM_MIX_RULE.timeWindow],
    completionPercent: [...DEFAULT_CUSTOM_MIX_RULE.completionPercent],
    genrePercent: [...DEFAULT_CUSTOM_MIX_RULE.genrePercent],
    sources: [...DEFAULT_CUSTOM_MIX_RULE.sources],
    specials: [...DEFAULT_CUSTOM_MIX_RULE.specials],
    forgottenPercent: [...DEFAULT_CUSTOM_MIX_RULE.forgottenPercent],
    forgottenDays: [...DEFAULT_CUSTOM_MIX_RULE.forgottenDays],
    artistIds: [...DEFAULT_CUSTOM_MIX_RULE.artistIds],
    genres: [...DEFAULT_CUSTOM_MIX_RULE.genres],
  }
}

/** Apply defaults introduced after the first saved custom mix rules existed. */
export function normalizeCustomMixRule(rule: CustomMixRule): CustomMixRule {
  const trackCount = Number.isFinite(rule.trackCount)
    ? rule.trackCount
    : DEFAULT_CUSTOM_MIX_RULE.trackCount
  const refreshIntervalMinutes = Number.isFinite(rule.refreshIntervalMinutes)
    ? rule.refreshIntervalMinutes
    : DEFAULT_CUSTOM_MIX_RULE.refreshIntervalMinutes
  return {
    ...rule,
    description: typeof rule.description === 'string' ? rule.description : '',
    trackCount,
    refreshIntervalMinutes,
    artistIds: [...rule.artistIds],
    timeWindow: [...rule.timeWindow],
    completionPercent: [...rule.completionPercent],
    genres: [...rule.genres],
    genrePercent: [...rule.genrePercent],
    sources: [...rule.sources],
    specials: [...rule.specials],
    forgottenPercent: [...rule.forgottenPercent],
    forgottenDays: [...rule.forgottenDays],
  }
}
