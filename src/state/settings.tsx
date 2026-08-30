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
}

export const defaultSettings: AppSettings = {
  lang: 'system',
  theme: { kind: 'preset', presetId: 'tempo' },
  startupPage: 'home',
  profile: { nickname: null, avatarPath: null, onboarded: false },
  font: { family: null, importedPath: null, sizePx: 13, uiScalePct: 100 },
  background: { path: null, dimPct: 45, blurPx: 0 },
  player: { waveform: false },
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
      font: { ...defaultSettings.font, ...parsed.font },
      background: { ...defaultSettings.background, ...parsed.background },
      player: { ...defaultSettings.player, ...parsed.player },
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
      font: { ...prev.font, ...patch.font },
      background: { ...prev.background, ...patch.background },
      player: { ...prev.player, ...patch.player },
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
