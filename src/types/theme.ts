export interface ThemeTokens {
  bg: string
  bgElevated: string
  surface: string
  surfaceHover: string
  border: string
  text: string
  textMuted: string
  accent: string
  accentStrong: string
  accentSoft: string
  danger: string
  playButton: string
}

export interface ThemePreset {
  id: string
  name: string
  tokens: ThemeTokens
}

export interface CustomTheme {
  base: {
    accent: string
    background: string
    surface: string
    playButton?: string
  }
  overrides: Partial<ThemeTokens>
}

export type ActiveTheme = { kind: 'preset'; presetId: string } | { kind: 'custom'; custom: CustomTheme }

export const TOKEN_VARS: Record<keyof ThemeTokens, string> = {
  bg: '--bg',
  bgElevated: '--bg-elevated',
  surface: '--surface',
  surfaceHover: '--surface-hover',
  border: '--border',
  text: '--text',
  textMuted: '--text-muted',
  accent: '--accent',
  accentStrong: '--accent-strong',
  accentSoft: '--accent-soft',
  danger: '--danger',
  playButton: '--play-btn',
}
