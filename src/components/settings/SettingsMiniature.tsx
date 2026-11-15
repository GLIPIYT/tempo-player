import { useState, type CSSProperties, type ReactNode } from 'react'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import type { ThemeTokens } from '../../types/theme'
import type { AppSettings } from '../../state/settings'
import { useT } from '../../i18n'

const BARS = [4, 7, 5, 11, 9, 14, 8, 12, 16, 13, 6, 11, 7, 9, 4, 6, 10, 5, 7, 4]

export function SettingsMiniature({
  lyrics, waveform = false, playerHidden = false, tokens, gradientAnchors, children,
}: {
  lyrics?: AppSettings['lyrics']
  waveform?: boolean
  playerHidden?: boolean
  tokens?: ThemeTokens
  gradientAnchors?: { first: string; second: string }
  children?: ReactNode
}) {
  const scale = playerHidden && lyrics?.enlargeWhenCollapsed ? 1.5 : 1
  const accent = gradientAnchors
    ? `linear-gradient(110deg, ${gradientAnchors.first}, ${gradientAnchors.second})`
    : tokens?.accent
  const style = {
    ...(tokens && {
      '--set-mini-bg': tokens.bg,
      '--set-mini-surface': tokens.bgElevated,
      '--set-mini-border': tokens.border,
      '--set-mini-ink': tokens.text,
      '--set-mini-accent': accent,
    }),
    ...(lyrics && {
      '--set-mini-line-size': `${Math.round(lyrics.textSizePx * scale / 4)}px`,
      '--set-mini-progress-opacity': lyrics.progressOpacityPct / 100,
      '--set-mini-progress-height': `${Math.max(1, lyrics.progressThicknessPx / 2)}px`,
      '--set-mini-progress-color': lyrics.progressColorMode === 'custom' ? lyrics.progressColor : undefined,
    }),
  } as CSSProperties
  return (
    <div className="set-miniature" data-view={lyrics ? 'lyrics' : 'library'}
      data-compact={Boolean(tokens)} data-player-hidden={playerHidden}
      data-alignment={lyrics?.alignment} data-fill={lyrics?.textFillMode}
      data-progress={lyrics?.fillEnabled} data-direction={lyrics?.progressDirection}
      data-clip-progress={lyrics?.progressClipToText}
      data-motion={lyrics?.motionStyle} style={style} aria-hidden="true">
      <div className="set-miniature-title"><i /><i /></div>
      <div className="set-miniature-side">
        {lyrics ? <><i className="set-miniature-art" /><b /><b /></> : <><i /><i /><i /><i /><i /></>}
      </div>
      <div className="set-miniature-body">
        {lyrics ? <><i /><i /><i className="is-playing" /><i /><i /></> : (
          <>
            <i className="set-miniature-search" />
            <i className="set-miniature-heading" />
            <div className="set-miniature-albums">
              {[0, 1, 2, 3, 4].map(index => <i key={index} className="set-miniature-art" />)}
            </div>
          </>
        )}
      </div>
      {children ? <div className="set-miniature-visualizer">{children}</div> : null}
      <div className="set-miniature-transport">
        <div className="set-miniature-track"><i className="set-miniature-art" /><b /></div>
        <div className={waveform ? 'set-miniature-waveform' : 'set-miniature-progress'}>
          {waveform ? BARS.map((height, index) => (
            <i key={index} style={{ '--set-mini-bar': height } as CSSProperties} />
          )) : null}
        </div>
        <i className="set-miniature-volume" />
      </div>
    </div>
  )
}

export function SettingsLyricsPreview({ lyrics }: { lyrics: AppSettings['lyrics'] }) {
  const t = useT()
  const [playerHidden, setPlayerHidden] = useState(false)
  const Icon = playerHidden ? PanelLeftOpen : PanelLeftClose
  const label = t(playerHidden ? 'Show player in preview' : 'Hide player in preview')
  return (
    <section className="set-card set-preview-card" aria-label={t('Lyrics preview')}>
      <div className="set-preview-heading">
        <h3 className="set-card-title">{t('Lyrics preview')}</h3>
        <button type="button" className="icon-btn" aria-label={label} title={label}
          aria-pressed={playerHidden} onClick={() => setPlayerHidden(value => !value)}>
          <Icon size={17} aria-hidden="true" />
        </button>
      </div>
      <SettingsMiniature lyrics={lyrics} playerHidden={playerHidden} />
    </section>
  )
}
