import { useState, type CSSProperties } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useSettings, VISUALIZER_BARS_MIN, VISUALIZER_BARS_MAX, LYRICS_VISUALIZER_BARS_MAX, LYRICS_VISUALIZER_HEIGHT_MAX, type AppSettings, type VisualizerStyle } from '../../state/settings'
import { useT } from '../../i18n'
import VisualizerPreview from './VisualizerPreview'
import './visualizerSettings.css'

export default function VisualizerSettingsPanel() {
  const t = useT()
  const { settings, update } = useSettings()
  const [lyrics, setLyrics] = useState(false)
  const viz = lyrics ? settings.lyricsVisualizer : settings.visualizer
  const change = (patch: Partial<AppSettings['lyricsVisualizer']>) => {
    if (lyrics) update({ lyricsVisualizer: patch })
    else update({ visualizer: patch })
  }
  const slider = (key: 'bars' | 'heightPx' | 'opacityPct' | 'smoothing', label: string, min: number, max: number, step: number, suffix = '') => <div className="set-row" key={key}>
    <span className="set-row-label">{t(label)}</span><div className="slider-row">
      <input type="range" min={min} max={max} step={step} value={viz[key]} aria-label={t(label)} style={{ '--fill': `${(viz[key] - min) / (max - min) * 100}%` } as CSSProperties} onChange={e => change({ [key]: Number(e.target.value) })} />
      <span className="slider-value">{viz[key]}{suffix}</span>
    </div>
  </div>
  const toggle = (label: string, active: boolean, onClick: () => void, disabled = false) => <div className={`set-row${disabled ? ' is-dim' : ''}`}>
    <span className="set-row-label">{t(label)}</span><button type="button" className={`switch${active ? ' is-on' : ''}`} role="switch" aria-label={t(label)} aria-checked={active} disabled={disabled} onClick={onClick} />
  </div>
  return <section className={`set-card set-viz-pages${lyrics ? ' is-lyrics' : ''}`}>
    <div className="set-card-title" key={String(lyrics)}>{t(lyrics ? 'Lyrics visualizer' : 'Visualizer')}</div>
    <div className="set-viz-page-frame">
      <button type="button" className={`set-viz-page-arrow is-left${lyrics ? ' is-visible' : ''}`} tabIndex={lyrics ? 0 : -1} aria-hidden={!lyrics} aria-label={t('Player visualizer')} onClick={() => setLyrics(false)}><ChevronLeft size={20} /></button>
      <div key={String(lyrics)} className={`set-viz-page-preview${lyrics ? ' from-right' : ' from-left'}`}>
        {lyrics && <div className="set-viz-lyrics-mock" aria-hidden="true"><div className="set-viz-mock-info"><i /><b /><span /></div><div className="set-viz-mock-lines"><i /><i /><i /><i /></div></div>}
        <VisualizerPreview visualizer={viz} theme={settings.theme} offLabel={t('Off')} backgroundColor={lyrics && settings.lyricsVisualizer.useBackgroundColor} />
      </div>
      <button type="button" className={`set-viz-page-arrow is-right${!lyrics ? ' is-visible' : ''}`} tabIndex={lyrics ? -1 : 0} aria-hidden={lyrics} aria-label={t('Lyrics visualizer')} onClick={() => setLyrics(true)}><ChevronRight size={20} /></button>
    </div>
    <div key={`controls-${lyrics}`} className={`set-viz-page-controls${lyrics ? ' from-right' : ' from-left'}`}>
      <div className="seg" role="group" aria-label={t(lyrics ? 'Lyrics visualizer' : 'Visualizer')}>
        {(['off', 'bars', 'wave', 'line'] as VisualizerStyle[]).map((style, i) => <button key={style} type="button" className={`seg-btn${viz.style === style ? ' is-active' : ''}`} aria-pressed={viz.style === style} onClick={() => change({ style })}>{t(['Off', 'Bars', 'Wave', 'Line'][i])}</button>)}
      </div>
      <div className={viz.style === 'off' ? 'set-block is-dim' : 'set-block'}>
        <div className="set-viz-sliders">
          {slider('bars', 'Detail', VISUALIZER_BARS_MIN, lyrics ? LYRICS_VISUALIZER_BARS_MAX : VISUALIZER_BARS_MAX, 4)}
          {slider('heightPx', 'Height', 24, lyrics ? LYRICS_VISUALIZER_HEIGHT_MAX : 160, 4, 'px')}
          {slider('opacityPct', 'Opacity', 10, 100, 5, '%')}
          {slider('smoothing', 'Smoothing', 0, 100, 5, '%')}
        </div>
        <div className="set-viz-toggles">
          {toggle('Theme colour', viz.useThemeColor, () => change({ useThemeColor: !viz.useThemeColor }), lyrics && settings.lyricsVisualizer.useBackgroundColor)}
          {lyrics && toggle('Match background', settings.lyricsVisualizer.useBackgroundColor, () => change({ useBackgroundColor: !settings.lyricsVisualizer.useBackgroundColor }), viz.useThemeColor)}
          {toggle('Mirror', viz.mirror, () => change({ mirror: !viz.mirror }))}
        </div>
      </div>
    </div>
  </section>
}
