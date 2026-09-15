import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ActiveTheme } from '../types/theme'

export type StartupPage = 'home' | 'library' | 'albums' | 'artists' | 'playlists'

const STARTUP_PAGES: StartupPage[] = ['home', 'library', 'albums', 'artists', 'playlists']

export interface ProfileSettings {
  nickname: string | null
  avatarPath: string | null
  onboarded: boolean
}

export interface AppSettings {
  lang: 'ru' | 'en' | 'system'
  theme: ActiveTheme
  startupPage: StartupPage
  profile: ProfileSettings
  discord: {
    enabled: boolean
    clientId: string
  }
  lyrics: {
    cacheOnline: boolean
  }
  font: {
    family: string | null
    importedPath: string | null
    sizePx: number
    uiScalePct: number
  }
  background: {
    path: string | null
    dimPct: number
    blurPx: number
  }
  player: {
    waveform: boolean
  }
  sidebar: {
    grouped: boolean
  }
  miniPlayer: {
    enabled: boolean
    autoShowOnTrackChange: boolean
    /** How long the mini player stays expanded after a track change. */
    autoShowDurationMs: number
    /** Keep the pill on screen instead of parking it above the top edge. */
    alwaysShowButton: boolean
    /** Head the card with "Now playing" for the first half of an automatic peek. */
    showNowPlaying: boolean
  }
  system: {
    /** Register Tempo as a login item so it starts with Windows. */
    autostart: boolean
    /** Closing the main window parks Tempo in the tray instead of quitting. */
    closeToTray: boolean
  }
}

export const defaultSettings: AppSettings = {
  lang: 'system',
  theme: { kind: 'preset', presetId: 'tempo' },
  startupPage: 'home',
  profile: { nickname: null, avatarPath: null, onboarded: false },
  discord: { enabled: false, clientId: '1543766505295183904' },
  lyrics: { cacheOnline: true },
  font: { family: null, importedPath: null, sizePx: 13, uiScalePct: 100 },
  background: { path: null, dimPct: 45, blurPx: 0 },
  player: { waveform: false },
  sidebar: { grouped: true },
  // off by default: an always-on-top window appearing unprompted after an
  // update is worse than a feature nobody notices
  miniPlayer: {
    enabled: false,
    autoShowOnTrackChange: true,
    autoShowDurationMs: 3000,
    alwaysShowButton: false,
    showNowPlaying: true,
  },
  system: { autostart: false, closeToTray: false },
}

const MINI_SHOW_MS_MIN = 1000
const MINI_SHOW_MS_MAX = 15000

export function clampMiniShowMs(value: number): number {
  if (!Number.isFinite(value)) return defaultSettings.miniPlayer.autoShowDurationMs
  return Math.max(MINI_SHOW_MS_MIN, Math.min(MINI_SHOW_MS_MAX, Math.round(value)))
}

const STORAGE_KEY = 'tempo.settings.v1'

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] }

type SettingsPatch = Omit<DeepPartial<AppSettings>, 'theme'> & { theme?: ActiveTheme }

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultSettings
    const parsed = JSON.parse(raw) as SettingsPatch
    return {
      ...defaultSettings,
      ...parsed,
      startupPage: STARTUP_PAGES.includes(parsed.startupPage as StartupPage)
        ? (parsed.startupPage as StartupPage)
        : defaultSettings.startupPage,
      profile: { ...defaultSettings.profile, ...parsed.profile },
      discord: {
        ...defaultSettings.discord,
        ...parsed.discord,
        clientId:
          parsed.discord?.clientId && parsed.discord.clientId.trim()
            ? parsed.discord.clientId
            : defaultSettings.discord.clientId,
      },
      lyrics: { ...defaultSettings.lyrics, ...parsed.lyrics },
      font: { ...defaultSettings.font, ...parsed.font },
      background: { ...defaultSettings.background, ...parsed.background },
      player: { ...defaultSettings.player, ...parsed.player },
      sidebar: { ...defaultSettings.sidebar, ...parsed.sidebar },
      miniPlayer: {
        ...defaultSettings.miniPlayer,
        ...parsed.miniPlayer,
        autoShowDurationMs: clampMiniShowMs(
          parsed.miniPlayer?.autoShowDurationMs ?? defaultSettings.miniPlayer.autoShowDurationMs,
        ),
      },
      system: { ...defaultSettings.system, ...parsed.system },
    }
  } catch {
    return defaultSettings
  }
}

interface SettingsApi {
  settings: AppSettings
  update: (patch: SettingsPatch) => void
  resetAppearance: () => void
}

const SettingsContext = createContext<SettingsApi | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(load)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
      /* storage full or unavailable */
    }
  }, [settings])

  const update = useCallback((patch: SettingsPatch) => {
    setSettings((prev) => ({
      ...prev,
      ...patch,
      profile: { ...prev.profile, ...patch.profile },
      discord: { ...prev.discord, ...patch.discord },
      lyrics: { ...prev.lyrics, ...patch.lyrics },
      font: { ...prev.font, ...patch.font },
      background: { ...prev.background, ...patch.background },
      player: { ...prev.player, ...patch.player },
      sidebar: { ...prev.sidebar, ...patch.sidebar },
      miniPlayer: {
        ...prev.miniPlayer,
        ...patch.miniPlayer,
        autoShowDurationMs: clampMiniShowMs(
          patch.miniPlayer?.autoShowDurationMs ?? prev.miniPlayer.autoShowDurationMs,
        ),
      },
      system: { ...prev.system, ...patch.system },
    }))
  }, [])

  const resetAppearance = useCallback(() => {
    setSettings((prev) => ({
      ...prev,
      theme: defaultSettings.theme,
    }))
  }, [])

  const value = useMemo(() => ({ settings, update, resetAppearance }), [settings, update, resetAppearance])

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings(): SettingsApi {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings used outside SettingsProvider')
  return ctx
}
