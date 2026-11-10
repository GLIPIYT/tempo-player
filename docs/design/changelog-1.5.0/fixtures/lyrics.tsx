import { StrictMode, useCallback, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { Pause, SkipBack, SkipForward, Volume2, X } from 'lucide-react'
import { I18nProvider } from '../../../../src/i18n'
import LyricsProcessingPanel from '../../../../src/components/settings/LyricsProcessingPanel'
import { SyncedView } from '../../../../src/features/lyrics/SyncedView'
import type { ResolvedLyricsTiming } from '../../../../src/features/lyrics/timingResolver'
import { SettingsProvider } from '../../../../src/state/settings'
import { fmtTime } from '../../../../src/utils/format'
import showcase from '../user-showcase.json'
import './lyrics.css'

const track = showcase.tracks.find(item => item.id === showcase.lyricClip.trackId)!
const COVER = track.coverPath
const title = track.title
const artist = track.artistName
const durationSec = showcase.lyricClip.duration
const positionSec = 15.1
const noOp = () => undefined

// These are the only lyric lines included in the sanitized showcase export.
const lyricClip = showcase.lyricClip.lines

// The export contains the two text lines but no timestamps. This cue window is
// only a poster staging aid for the frozen 15.1s position, not analyzed timing.
const timing: ResolvedLyricsTiming = {
  lines: [],
  segments: [
    {
      kind: 'line', timeSec: 8, endTimeSec: 21.7, text: lyricClip[0],
      seekToSec: 8, lineIndices: [0],
    },
    {
      kind: 'line', timeSec: 22, endTimeSec: 35, text: lyricClip[1],
      seekToSec: 22, lineIndices: [1],
    },
  ],
}

function LyricsFixture() {
  const getPosition = useCallback(() => positionSec, [])
  const progressPct = (positionSec / durationSec) * 100
  const seekProgressStyle = { '--lyr-seek-progress': `${progressPct}%` } as CSSProperties
  return (
    <main className="lyr-overlay" aria-label="Tempo lyrics preview">
      <div className="lyr-bg" aria-hidden="true">
        <img className="lyr-bg-img" src={COVER} alt="" draggable={false} />
        <div className="lyr-bg-shade" />
        <div className="lyr-bg-vignette" />
      </div>
      <button className="lyr-close" aria-label="Закрыть"><X size={20} /></button>
      <div className="lyr-body">
        <aside className="lyr-side">
          <div className="lyr-cover-shell">
            <div className="lyr-cover">
              <img className="lyrics-artwork" src={COVER} alt={`Обложка альбома «${title}»`} />
            </div>
          </div>
          <div className="lyr-title">{title}</div>
          <div className="lyr-artists">{artist}</div>
          <div className="lyr-time-row" aria-label={`Позиция ${fmtTime(positionSec)} из ${fmtTime(durationSec)}`}>
            <span className="lyr-time lyr-time-cur">{fmtTime(positionSec)}</span>
            <input
              className="lyr-seek-range"
              type="range"
              min={0}
              max={durationSec}
              step={0.1}
              value={positionSec}
              disabled
              aria-label="Перемотка"
              style={seekProgressStyle}
            />
            <span className="lyr-time lyr-time-total">{fmtTime(durationSec)}</span>
          </div>
          <div className="lyr-controls">
            <button className="lyr-skip" aria-label="Предыдущий"><SkipBack size={22} /></button>
            <button className="lyr-play" aria-label="Пауза"><Pause size={26} /></button>
            <button className="lyr-skip" aria-label="Следующий"><SkipForward size={22} /></button>
          </div>
          <div className="lyr-volume-row">
            <Volume2 size={16} className="lyr-volume-icon" />
            <input className="lyr-volume-range" type="range" min={0} max={1} step={0.01} value={0.72} onChange={noOp} style={{ '--fill': '72%' } as CSSProperties} aria-label="Громкость" />
            <span className="lyr-volume-pct">72%</span>
          </div>
        </aside>
        <div className="lyr-divider-wrap" aria-hidden="true">
          <div className="lyr-divider" />
        </div>
        <section className="lyr-stage-col lyr-align-center lyr-progress-theme" aria-label="Синхронизированный текст">
          <SyncedView
            timing={timing}
            lyricsRate={1}
            offsetMs={0}
            alignment="center"
            progressClipToText
            progressDirection="left-to-right"
            fillEnabled
            textFillMode="words"
            capitalizeLines={false}
            playbackRate={1}
            onSeek={noOp}
            getPosition={getPosition}
          />
        </section>
      </div>
    </main>
  )
}

function ProcessingFixture() {
  return (
    <div className="processing-fixture">
      <LyricsProcessingPanel
        vocalEnabled
        wordEnabled
        wordMode
        modelState={{ enabled: true, phase: 'ready', loadedBytes: 75_000_000, totalBytes: 75_000_000, error: null }}
        wordAnalysisState={{ phase: 'complete', error: null, unavailableReason: null }}
        vocalState={{ phase: 'complete', error: null }}
        onVocalChange={noOp}
        onWordChange={noOp}
        onRetryModel={noOp}
        onRetryAnalysis={noOp}
        onRetryVocal={noOp}
      />
    </div>
  )
}

const isProcessing = new URLSearchParams(location.search).get('view') === 'processing'
document.documentElement.dataset.view = isProcessing ? 'processing' : 'lyrics'
document.body.dataset.view = isProcessing ? 'processing' : 'lyrics'
localStorage.setItem('tempo.settings.v1', JSON.stringify({ lang: 'ru' }))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsProvider>
      <I18nProvider>{isProcessing ? <ProcessingFixture /> : <LyricsFixture />}</I18nProvider>
    </SettingsProvider>
  </StrictMode>,
)
