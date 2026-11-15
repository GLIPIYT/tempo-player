import { useState } from 'react'
import { AudioLines, ChevronLeft, ChevronRight, SlidersHorizontal } from 'lucide-react'
import { useSettings, VISUALIZER_BARS_MIN, VISUALIZER_BARS_MAX, LYRICS_VISUALIZER_BARS_MAX, LYRICS_VISUALIZER_HEIGHT_MAX, type AppSettings, type VisualizerStyle } from '../../state/settings'
import { useT } from '../../i18n'
import { Segmented, SettingsSwitch, SliderRow } from './SettingsControls'
import { SettingsMiniature } from './SettingsMiniature'
import { SettingsSection } from './SettingsSection'
import VisualizerPreview from './VisualizerPreview'

const STYLES = [
  { value: 'off', label: 'Off' },
  { value: 'bars', label: 'Bars' },
  { value: 'wave', label: 'Wave' },
  { value: 'line', label: 'Line' },
] as const

export default function VisualizerSettingsPanel() {
  const t = useT()
  const { settings, update } = useSettings()
  const [lyrics, setLyrics] = useState(false)
  const viz = lyrics ? settings.lyricsVisualizer : settings.visualizer
  const change = (patch: Partial<AppSettings['lyricsVisualizer']>) => {
    if (lyrics) update({ lyricsVisualizer: patch })
    else update({ visualizer: patch })
  }

  const off = viz.style === 'off'
  const matchBackground = lyrics && settings.lyricsVisualizer.useBackgroundColor
  const title = t(lyrics ? 'Lyrics visualizer' : 'Visualizer')
  const nextTitle = t(lyrics ? 'Player visualizer' : 'Lyrics visualizer')
  const Arrow = lyrics ? ChevronLeft : ChevronRight

  return (
    <>
      <section className="set-card set-preview-card" aria-label={title}>
        <div className="set-preview-heading">
          <h3 className="set-card-title">{title}</h3>
          <button type="button" className={lyrics ? 'icon-btn set-preview-back' : 'icon-btn'}
            aria-label={nextTitle} title={nextTitle} onClick={() => setLyrics(value => !value)}>
            <Arrow size={18} aria-hidden="true" />
          </button>
        </div>
        <SettingsMiniature key={String(lyrics)}
          waveform={settings.player.waveform} lyrics={lyrics ? settings.lyrics : undefined}>
          <VisualizerPreview visualizer={viz} theme={settings.theme} offLabel={t('Off')} backgroundColor={matchBackground} />
        </SettingsMiniature>
      </section>
      <SettingsSection id="visualizer-main" title={t('Basic parameters')} icon={AudioLines} defaultOpen>
        <div className="set-row">
          <span className="set-row-label">{t('Visualizer mode')}</span>
          <Segmented<VisualizerStyle> label={t('Visualizer mode')} value={viz.style}
            options={STYLES.map(option => ({ value: option.value, label: t(option.label) }))}
            onChange={style => change({ style })} />
        </div>
        <SliderRow label={t('Detail')} min={VISUALIZER_BARS_MIN}
          max={lyrics ? LYRICS_VISUALIZER_BARS_MAX : VISUALIZER_BARS_MAX} step={4}
          value={viz.bars} display={String(viz.bars)} disabled={off}
          onChange={bars => change({ bars })} />
        <SliderRow label={t('Height')} min={24}
          max={lyrics ? LYRICS_VISUALIZER_HEIGHT_MAX : 160} step={4}
          value={viz.heightPx} display={`${viz.heightPx}px`} disabled={off}
          onChange={heightPx => change({ heightPx })} />
        <SliderRow label={t('Opacity')} min={10} max={100} step={5}
          value={viz.opacityPct} display={`${viz.opacityPct}%`} disabled={off}
          onChange={opacityPct => change({ opacityPct })} />
      </SettingsSection>
      <SettingsSection id="visualizer-motion" title={t('Motion and color')} icon={SlidersHorizontal}>
        <SliderRow label={t('Smoothing')} min={0} max={100} step={5}
          value={viz.smoothing} display={`${viz.smoothing}%`} disabled={off}
          onChange={smoothing => change({ smoothing })} />
        <div className="set-row">
          <span className="set-row-label">{t('Theme colour')}</span>
          <SettingsSwitch label={t('Theme colour')} checked={viz.useThemeColor} disabled={off || matchBackground}
            onClick={() => change({ useThemeColor: !viz.useThemeColor })} />
        </div>
        {lyrics ? (
          <div className="set-row">
            <span className="set-row-label">{t('Match background')}</span>
            <SettingsSwitch label={t('Match background')} checked={matchBackground} disabled={off || viz.useThemeColor}
              onClick={() => change({ useBackgroundColor: !matchBackground })} />
          </div>
        ) : null}
        <div className="set-row">
          <span className="set-row-label">{t('Mirror')}</span>
          <SettingsSwitch label={t('Mirror')} checked={viz.mirror} disabled={off}
            onClick={() => change({ mirror: !viz.mirror })} />
        </div>
      </SettingsSection>
    </>
  )
}
