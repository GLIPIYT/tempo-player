import { useCallback, useEffect, useRef, useState } from 'react'
import { Gauge, Heart, ListMusic, MicVocal, Pause, Play, Radio, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from 'lucide-react'
import { api } from '../../api/client'
import { usePlayer } from '../../player'
import { useLikes } from '../../hooks/useLikes'
import { useSettings } from '../../state/settings'
import { useT } from '../../i18n'
import { fmtTime } from '../../utils/format'
import { trackToUnified } from '../../utils/unified'
import { toast } from '../common/Toast'
import Cover from '../common/Cover'
import { Spinner } from '../common/ScArtwork'
import WaveProgress from '../common/WaveProgress'
import QueuePanel from './QueuePanel'
import PlayerVisualizer from '../player/PlayerVisualizer'
import { LyricsContextProvider, useLyrics } from '../../features/lyrics'

let lastNonZeroVolume = 0.8
const PLAYBACK_RATES = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

function formatPlaybackRate(rate: number): string {
  return `${rate.toLocaleString(undefined, { maximumFractionDigits: 2 })}×`
}

export default function PlayerBar() {
  return (
    <LyricsContextProvider>
      <PlayerBarContent />
    </LyricsContextProvider>
  )
}

function PlayerBarContent() {
  const p = usePlayer()
  const { settings } = useSettings()
  // In the modern layout the progress line runs along the bar's top edge, so
  // the times move in beside the transport instead.
  const modern = settings.player.barStyle === 'modern'
  const likes = useLikes()
  const t = useT()
  const lyrics = useLyrics()
  const [queueOpen, setQueueOpen] = useState(false)
  const [speedOpen, setSpeedOpen] = useState(false)
  const speedRef = useRef<HTMLDivElement | null>(null)
  const currentDbId = p.currentTrack?.dbId ?? null
  const liked = currentDbId !== null && likes.isLiked(currentDbId)
  const [scrubbing, setScrubbing] = useState(false)
  const [scrubVal, setScrubVal] = useState<number | null>(null)
  const dur = p.duration > 0 ? p.duration : (p.currentTrack?.durationSec ?? 0)
  const maxDur = dur > 0 ? dur : 1
  const livePos = Math.min(Math.max(0, p.position), maxDur)
  const sliderVal = scrubbing && scrubVal !== null ? Math.min(scrubVal, maxDur) : livePos
  const pct = (sliderVal / maxDur) * 100
  const volPct = Math.round(p.volume * 100)
  const VolIcon = p.volume === 0 ? VolumeX : p.volume < 0.5 ? Volume1 : Volume2
  const bufPct = p.bufferPct
  const buffering = bufPct !== null && bufPct < 100

  useEffect(() => {
    p.setEqualizer(settings.audio.equalizer)
  }, [p.setEqualizer, settings.audio.equalizer])

  useEffect(() => {
    if (!speedOpen) return
    const onDown = (e: MouseEvent) => {
      if (speedRef.current && !speedRef.current.contains(e.target as Node)) setSpeedOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSpeedOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [speedOpen])

  const commitScrub = useCallback(() => {
    if (scrubVal !== null && Number.isFinite(scrubVal)) p.seek(Math.max(0, scrubVal))
    setScrubbing(false)
    setScrubVal(null)
  }, [p, scrubVal])

  const commitRef = useRef(commitScrub)
  useEffect(() => {
    commitRef.current = commitScrub
  })

  useEffect(() => {
    if (!scrubbing) return
    const onUp = () => commitRef.current()
    window.addEventListener('pointerup', onUp)
    return () => window.removeEventListener('pointerup', onUp)
  }, [scrubbing])

  const toggleMute = () => {
    if (p.volume > 0) {
      lastNonZeroVolume = p.volume
      p.setVolume(0)
    } else {
      p.setVolume(lastNonZeroVolume > 0 ? lastNonZeroVolume : 0.8)
    }
  }

  const playRadio = async () => {
    try {
      const total = await api.countTracks()
      if (total <= 0) return
      const offset = Math.floor(Math.random() * total)
      const rows = await api.listTracks('', 1, offset)
      if (rows[0]) {
        p.playTracks([trackToUnified(rows[0])], 0)
        toast.show(`${t('Radio')}: ${rows[0].title}`)
      }
    } catch {}
  }

  return (
    <>
      <footer className={'playerbar' + (modern ? ' pb-modern' : '')}>
        <PlayerVisualizer />
        <div className="pb-now">
          {p.currentTrack ? (
            <>
              <div className="pb-cover-wrap" onDoubleClick={lyrics.openLyrics}>
                <div className="pb-cover-box">
                  <Cover path={p.currentTrack.coverPath} label={p.currentTrack.title} size={48} />
                  {buffering ? (
                    <>
                      <svg
                        className="pb-buffer-ring"
                        viewBox="0 0 52 52"
                        width={52}
                        height={52}
                        aria-hidden="true"
                        style={{ position: 'absolute', inset: '-2px', width: '52px', height: '52px', pointerEvents: 'none' }}
                      >
                        <rect
                          x="1"
                          y="1"
                          width="50"
                          height="50"
                          rx="6"
                          ry="6"
                          fill="none"
                          stroke="var(--accent)"
                          strokeWidth={2}
                          pathLength={100}
                          strokeDasharray="100"
                          strokeDashoffset={100 - Math.round(bufPct as number)}
                        />
                      </svg>
                      <span className="pb-buffer-pct" aria-hidden="true">
                        {Math.round(bufPct as number)}%
                      </span>
                    </>
                  ) : null}
                </div>
              </div>
              <div className="pb-meta">
                <span className="pb-title" title={p.currentTrack.title}>
                  {p.currentTrack.title}
                </span>
                {p.preparing ? (
                  // Fetching the track before it can start. Saying so beats a
                  // bar that sits at 0:00 with no explanation.
                  <span className="pb-artist pb-preparing">{t('Preparing…')}</span>
                ) : (
                  <span className="pb-artist">
                    {p.currentTrack.resolving ? (
                      <Spinner size={10} />
                    ) : (
                      p.currentTrack.artists.join(', ') || t('Unknown artist')
                    )}
                  </span>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="pb-placeholder">
                <ListMusic size={20} />
              </div>
              <div className="pb-meta">
                <span className="pb-title">{t('Nothing playing')}</span>
                <span className="pb-artist">{t('Double-click a track to start')}</span>
              </div>
            </>
          )}
        </div>

        <div className="pb-controls">
          {modern ? (
            <span className="pb-time pb-time-cur">
              {fmtTime(scrubbing && scrubVal !== null ? Math.min(scrubVal, maxDur) : p.position)}
            </span>
          ) : null}
          <button
            className={'icon-btn' + (p.shuffle ? ' is-active' : '')}
            onClick={() => p.toggleShuffle()}
            aria-label={t('Shuffle')}
            title={t('Shuffle')}
          >
            <Shuffle size={15} />
          </button>
          <button className="icon-btn" onClick={() => p.previous()} aria-label={t('Previous track')}>
            <SkipBack size={17} />
          </button>
          <button
            className="pb-toggle"
            style={{ background: 'var(--play-btn, var(--accent))' }}
            onClick={() => p.toggle()}
            aria-label={p.isPlaying ? t('Pause') : t('Play')}
          >
            {p.isPlaying ? <Pause size={18} /> : <Play size={18} className="pb-play-glyph" />}
          </button>
          <button className="icon-btn" onClick={() => p.next()} aria-label={t('Next track')}>
            <SkipForward size={17} />
          </button>
          <button
            className={'icon-btn' + (p.repeat !== 'off' ? ' is-active' : '')}
            onClick={() => p.setRepeat(p.repeat === 'off' ? 'all' : p.repeat === 'all' ? 'one' : 'off')}
            aria-label={
              p.repeat === 'one'
                ? t('Repeat one')
                : p.repeat === 'all'
                  ? t('Repeat all')
                  : t('Repeat off')
            }
            title={
              p.repeat === 'one'
                ? t('Repeat one')
                : p.repeat === 'all'
                  ? t('Repeat all')
                  : t('Repeat off')
            }
          >
            {p.repeat === 'one' ? <Repeat1 size={16} /> : <Repeat size={15} />}
          </button>
          {modern ? <span className="pb-time">{fmtTime(dur)}</span> : null}
        </div>

        <div className="pb-progress">
          {modern ? null : (
            <span className="pb-time pb-time-cur">
              {fmtTime(scrubbing && scrubVal !== null ? Math.min(scrubVal, maxDur) : p.position)}
            </span>
          )}
          {settings.player.waveform ? (
            <WaveProgress
              seed={p.currentTrack?.sourceId ?? 'none'}
              position={livePos}
              duration={maxDur}
              onSeek={p.seek}
            />
          ) : (
            <input
              type="range"
              min={0}
              max={maxDur}
              step={0.1}
              value={sliderVal}
              onPointerDown={() => {
                setScrubbing(true)
                setScrubVal(livePos)
              }}
              onChange={(e) => {
                const v = e.target.valueAsNumber
                if (scrubbing) setScrubVal(v)
                else p.seek(v)
              }}
              onKeyUp={() => {
                if (scrubbing) commitScrub()
              }}
              style={{ background: `linear-gradient(to right, var(--accent) ${pct}%, var(--border) ${pct}%)` }}
              aria-label={t('Seek')}
            />
          )}
          {modern ? null : <span className="pb-time">{fmtTime(dur)}</span>}
        </div>

        <div className="pb-right">
          {currentDbId !== null ? (
            <button
              className={'icon-btn pb-like-btn' + (liked ? ' is-active' : '')}
              onClick={() => likes.toggle(currentDbId)}
              aria-label={liked ? t('Remove from Likes') : t('Add to Likes')}
              title={liked ? t('Remove from Likes') : t('Add to Likes')}
            >
              <Heart size={16} fill={liked ? 'currentColor' : 'none'} />
            </button>
          ) : null}
          <div className="pb-speed-control" ref={speedRef}>
            <button
              className={'icon-btn pb-speed-trigger' + (p.playbackRate !== 1 ? ' is-active' : '')}
              onClick={() => setSpeedOpen((open) => !open)}
              aria-haspopup="dialog"
              aria-expanded={speedOpen}
              aria-label={t('Playback speed')}
              title={t('Playback speed')}
            >
              <Gauge size={15} />
              <span>{formatPlaybackRate(p.playbackRate)}</span>
            </button>
            {speedOpen && (
              <div className="pb-speed-menu" role="dialog" aria-label={t('Playback speed')}>
                <div className="pb-speed-menu-heading">
                  <span>{t('Playback speed')}</span>
                  <button
                    className="pb-speed-reset"
                    onClick={() => {
                      p.setPlaybackRate(1)
                      setSpeedOpen(false)
                    }}
                  >
                    {t('Reset speed')}
                  </button>
                </div>
                <div className="pb-speed-presets">
                  {PLAYBACK_RATES.map((rate) => (
                    <button
                      key={rate}
                      className={'pb-speed-preset' + (p.playbackRate === rate ? ' is-selected' : '')}
                      aria-pressed={p.playbackRate === rate}
                      onClick={() => {
                        p.setPlaybackRate(rate)
                        setSpeedOpen(false)
                      }}
                    >
                      {formatPlaybackRate(rate)}
                    </button>
                  ))}
                </div>
                <button
                  className="pb-speed-pitch"
                  role="switch"
                  aria-checked={p.preservePitch}
                  onClick={() => p.setPreservePitch(!p.preservePitch)}
                >
                  <span>{t('Preserve pitch')}</span>
                  <span className={p.preservePitch ? 'pb-speed-switch is-on' : 'pb-speed-switch'} aria-hidden="true">
                    <span />
                  </span>
                </button>
              </div>
            )}
          </div>
          <div className="pb-vol">
            <button
              className="icon-btn pb-vol-btn"
              onClick={toggleMute}
              aria-label={p.volume === 0 ? t('Unmute') : t('Mute')}
            >
              <VolIcon size={16} />
            </button>
            <input
              className="pb-volume"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={p.volume}
              onChange={(e) => p.setVolume(e.target.valueAsNumber)}
              style={{
                background: `linear-gradient(to right, var(--text) ${volPct}%, var(--border) ${volPct}%)`,
              }}
              aria-label={t('Volume')}
            />
            {/* second copy for the narrow layout; CSS decides which one shows,
                so the breakpoint lives in exactly one place */}
            <div className="pb-vol-pop">
              <input
                className="pb-volume"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={p.volume}
                onChange={(e) => p.setVolume(e.target.valueAsNumber)}
                style={{
                  background: `linear-gradient(to right, var(--text) ${volPct}%, var(--border) ${volPct}%)`,
                }}
                aria-label={t('Volume')}
              />
            </div>
          </div>
          <button
            className="icon-btn pb-radio-btn"
            onClick={() => void playRadio()}
            aria-label={t('Radio')}
            title={t('Radio')}
          >
            <Radio size={16} />
          </button>
          <button
            className={'icon-btn pb-lyrics-btn' + (lyrics.open ? ' is-active' : '')}
            onClick={() => (lyrics.open ? lyrics.closeLyrics() : lyrics.openLyrics())}
            aria-label={t('Toggle lyrics')}
          >
            <MicVocal size={16} />
          </button>
          <button
            className={'icon-btn pb-queue-btn' + (queueOpen ? ' is-active' : '')}
            onClick={() => setQueueOpen((o) => !o)}
            aria-label={t('Toggle queue')}
          >
            <ListMusic size={16} />
          </button>
        </div>
      </footer>
      <QueuePanel open={queueOpen} onClose={() => setQueueOpen(false)} />
    </>
  )
}
