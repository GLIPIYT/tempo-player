import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ActiveTheme } from '../types/theme'
import { DEFAULT_EQUALIZER_SETTINGS, normalizeEqualizer, type EqualizerSettings } from '../audio/equalizer'

export type StartupPage = 'home' | 'library' | 'albums' | 'artists' | 'playlists'

const STARTUP_PAGES: StartupPage[] = ['home', 'library', 'albums', 'artists', 'playlists']

/** What the spectrum band above the player bar draws. */
export type VisualizerStyle = 'off' | 'bars' | 'wave' | 'line'

const VISUALIZER_STYLES: VisualizerStyle[] = ['off', 'bars', 'wave', 'line']

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
    /**
     * Player bar layout. `classic` is the original: progress fills its column
     * between the transport and the right-hand controls. `modern` moves the
     * transport to the middle and runs the progress line along the bar's top
     * edge.
     */
    barStyle: 'classic' | 'modern'
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
  audio: {
    /** Level every track towards a common loudness using its measured gain. */
    normalize: boolean
    /** Seconds of overlap between tracks; 0 disables crossfade. */
    crossfadeSec: number
    /** Five-band equalizer; it is bypassed for uncached cross-origin streams. */
    equalizer: EqualizerSettings
  }
  soundcloud: {
    /**
     * Download a track in full before starting it. Costs a wait on the first
     * play, but the track then comes off disk - same-origin, inside the audio
     * graph - instead of streaming past it.
     */
    cacheBeforePlay: boolean
  }
  ytdlp: {
    /**
     * Path to a yt-dlp binary. Empty means "look on PATH".
     *
     * Deliberately not bundled: YouTube extraction breaks on YouTube's
     * schedule, and yt-dlp answers within days. Shipping our own copy would
     * mean a new release of this app every time, plus a Python runtime and a
     * JS runtime to go with it.
     */
    path: string
  }
  visualizer: {
    style: VisualizerStyle
    /** Bar count. The 64 incoming bins are interpolated up or down to this. */
    bars: number
    /** Peak amplitude in pixels. Does not change the band's own height. */
    heightPx: number
    /** Peak opacity, 10-100. */
    opacityPct: number
    /** 0 is twitchy, 100 is very smooth. */
    smoothing: number
    mirror: boolean
    /** Draw in the theme accent rather than the plain text colour. */
    useThemeColor: boolean
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
  player: { waveform: false, barStyle: 'classic' },
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
  audio: { normalize: false, crossfadeSec: 0, equalizer: DEFAULT_EQUALIZER_SETTINGS },
  // off by default: streaming starts immediately, which is what most people
  // expect from a search result
  soundcloud: { cacheBeforePlay: false },
  // Empty by default: most people already have yt-dlp on PATH, and asking for
  // a path before anything works would be a poor first impression.
  ytdlp: { path: '' },
  // On by default: the band is the whole point of the setting, and it only
  // ever routes the same-origin channel - the same thing normalisation does.
  visualizer: {
    style: 'bars',
    bars: 56,
    heightPx: 56,
    opacityPct: 80,
    smoothing: 45,
    mirror: false,
    useThemeColor: true,
  },
}

const MINI_SHOW_MS_MIN = 1000
const MINI_SHOW_MS_MAX = 15000

export function clampMiniShowMs(value: number): number {
  if (!Number.isFinite(value)) return defaultSettings.miniPlayer.autoShowDurationMs
  return Math.max(MINI_SHOW_MS_MIN, Math.min(MINI_SHOW_MS_MAX, Math.round(value)))
}

export const VISUALIZER_BARS_MIN = 8
export const VISUALIZER_BARS_MAX = 192
const VIZ_BARS_RANGE = [VISUALIZER_BARS_MIN, VISUALIZER_BARS_MAX] as const
const VIZ_HEIGHT_RANGE = [24, 160] as const
const VIZ_OPACITY_RANGE = [10, 100] as const
const VIZ_SMOOTHING_RANGE = [0, 100] as const

function clampInt(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

/**
 * Normalises the visualiser block. The values come from localStorage and can
 * be anything at all, and the canvas trusts them - clamping on the way in is
 * cheaper than defending in the render loop.
 */
export function clampVisualizer(value: Partial<AppSettings['visualizer']>): AppSettings['visualizer'] {
  const base = defaultSettings.visualizer
  return {
    style: VISUALIZER_STYLES.includes(value.style as VisualizerStyle)
      ? (value.style as VisualizerStyle)
      : base.style,
    bars: clampInt(value.bars, VIZ_BARS_RANGE, base.bars),
    heightPx: clampInt(value.heightPx, VIZ_HEIGHT_RANGE, base.heightPx),
    opacityPct: clampInt(value.opacityPct, VIZ_OPACITY_RANGE, base.opacityPct),
    smoothing: clampInt(value.smoothing, VIZ_SMOOTHING_RANGE, base.smoothing),
    mirror: value.mirror === true,
    useThemeColor: value.useThemeColor !== false,
  }
}

const STORAGE_KEY = 'tempo.settings.v1'

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] }

type SettingsPatch = Omit<DeepPartial<AppSettings>, 'theme'> & { theme?: ActiveTheme }

/**
 * The current settings, mirrored at module level for the handful of places
 * that are not components - the player's track resolution and the provider
 * registry. They run outside React, and threading a settings object down
 * through the whole player to reach one string would be worse than this.
 */
let currentSettings: AppSettings = defaultSettings

export function getSettings(): AppSettings {
  return currentSettings
}

function load(): AppSettings {  try {
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
      audio: {
        ...defaultSettings.audio,
        ...parsed.audio,
        equalizer: normalizeEqualizer(parsed.audio?.equalizer),
      },
      soundcloud: { ...defaultSettings.soundcloud, ...parsed.soundcloud },
      ytdlp: { ...defaultSettings.ytdlp, ...parsed.ytdlp },
      visualizer: clampVisualizer(parsed.visualizer ?? {}),
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
    // Kept in step with the state so the non-React readers above never see a
    // stale value.
    currentSettings = settings
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
      audio: {
        ...prev.audio,
        ...patch.audio,
        equalizer: patch.audio?.equalizer
          ? normalizeEqualizer({ ...prev.audio.equalizer, ...patch.audio.equalizer })
          : prev.audio.equalizer,
      },
      soundcloud: { ...prev.soundcloud, ...patch.soundcloud },
      ytdlp: { ...prev.ytdlp, ...patch.ytdlp },
      visualizer: clampVisualizer({ ...prev.visualizer, ...patch.visualizer }),
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
