export const EQUALIZER_BANDS = [
  { frequency: 60, label: '60 Hz', type: 'lowshelf' },
  { frequency: 250, label: '250 Hz', type: 'peaking' },
  { frequency: 1000, label: '1 kHz', type: 'peaking' },
  { frequency: 4000, label: '4 kHz', type: 'peaking' },
  { frequency: 12000, label: '12 kHz', type: 'highshelf' },
] as const

export const EQUALIZER_PRESETS = {
  flat: [0, 0, 0, 0, 0],
  bass: [6, 4, 1, 0, 0],
  treble: [0, 0, 1, 4, 6],
  vocal: [-2, 1, 4, 3, -1],
  rock: [4, 2, -1, 2, 4],
} as const

export type EqualizerPreset = keyof typeof EQUALIZER_PRESETS | 'custom'
export type EqualizerBands = [number, number, number, number, number]

export interface UserEqualizerPreset {
  id: string
  name: string
  bands: EqualizerBands
}

export interface EqualizerSettings {
  enabled: boolean
  preset: EqualizerPreset
  bands: EqualizerBands
  userPresets: UserEqualizerPreset[]
  selectedUserPresetId: string | null
}

export const EQUALIZER_MIN_DB = -12
export const EQUALIZER_MAX_DB = 12
export const MAX_USER_EQUALIZER_PRESETS = 12

export const DEFAULT_EQUALIZER_SETTINGS: EqualizerSettings = {
  enabled: false,
  preset: 'flat',
  bands: [0, 0, 0, 0, 0],
  userPresets: [],
  selectedUserPresetId: null,
}

function isPreset(value: unknown): value is EqualizerPreset {
  return value === 'custom' || Object.prototype.hasOwnProperty.call(EQUALIZER_PRESETS, value)
}

/** Settings are persisted locally, so validate them before audio nodes use them. */
export function normalizeEqualizer(value: unknown): EqualizerSettings {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const preset = isPreset(raw.preset) ? raw.preset : DEFAULT_EQUALIZER_SETTINGS.preset
  const presetBands = preset === 'custom' ? DEFAULT_EQUALIZER_SETTINGS.bands : EQUALIZER_PRESETS[preset]
  const rawBands = Array.isArray(raw.bands) ? raw.bands : []
  const bands = normalizeBands(rawBands, presetBands)
  const userPresets = Array.isArray(raw.userPresets)
    ? raw.userPresets
        .slice(0, MAX_USER_EQUALIZER_PRESETS)
        .map(normalizeUserPreset)
        .filter((item): item is UserEqualizerPreset => item !== null)
    : []
  const selectedUserPresetId = typeof raw.selectedUserPresetId === 'string' &&
      userPresets.some((item) => item.id === raw.selectedUserPresetId)
    ? raw.selectedUserPresetId
    : null

  return {
    enabled: raw.enabled === true,
    preset,
    bands,
    userPresets,
    selectedUserPresetId,
  }
}

function normalizeBands(value: unknown, fallback: readonly number[]): EqualizerBands {
  const values = Array.isArray(value) ? value : []
  return EQUALIZER_BANDS.map((_, index) => {
    const candidate = values[index]
    const defaultValue = fallback[index] ?? 0
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return defaultValue
    return Math.max(EQUALIZER_MIN_DB, Math.min(EQUALIZER_MAX_DB, Math.round(candidate)))
  }) as EqualizerBands
}

function normalizeUserPreset(value: unknown): UserEqualizerPreset | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id.slice(0, 80) : ''
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 32) : ''
  if (!id || !name) return null
  return { id, name, bands: normalizeBands(raw.bands, DEFAULT_EQUALIZER_SETTINGS.bands) }
}
