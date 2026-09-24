import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  Heart,
  ListMusic,
  MicVocal,
  Pause,
  Play,
  Radio,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Trash2,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react'
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
import {
  EQUALIZER_BANDS,
  EQUALIZER_MAX_DB,
  EQUALIZER_MIN_DB,
  EQUALIZER_PRESETS,
  MAX_USER_EQUALIZER_PRESETS,
  type EqualizerBands,
  type EqualizerPreset,
  type EqualizerSettings,
} from '../../audio/equalizer'

let lastNonZeroVolume = 0.8
const PLAYBACK_RATE_TICKS = Array.from({ length: 31 }, (_, index) => (50 + index * 5) / 100)
const EQUALIZER_PRESET_KEYS = ['flat', 'bass', 'treble', 'vocal', 'rock', 'custom'] as const
const EQUALIZER_PRESET_LABELS: Record<EqualizerPreset, string> = {
  flat: 'Flat',
  bass: 'Bass boost',
  treble: 'Treble',
  vocal: 'Vocal',
  rock: 'Rock',
  custom: 'Custom curve',
}

function formatPlaybackRate(rate: number): string {
  return `${rate.toLocaleString(undefined, { maximumFractionDigits: 2 })}×`
}

function PresetCurve({ bands }: { bands: readonly number[] }) {
  const points = bands.map((value, index) => `${2 + index * 5.5},${10 - value / EQUALIZER_MAX_DB * 8}`).join(' ')
  return (
    <svg className="pb-eq-curve" viewBox="0 0 54 20" aria-hidden="true">
      <line x1="2" y1="10" x2="52" y2="10" />
      <polyline points={points} />
    </svg>
  )
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
  const setEqualizer = p.setEqualizer
  const { settings, update } = useSettings()
  // In the modern layout the progress line runs along the bar's top edge, so
  // the times move in beside the transport instead.
  const modern = settings.player.barStyle === 'modern'
  const likes = useLikes()
  const t = useT()
  const lyrics = useLyrics()
  const [queueOpen, setQueueOpen] = useState(false)
  const [speedOpen, setSpeedOpen] = useState(false)
  const [presetMenuOpen, setPresetMenuOpen] = useState(false)
  const [presetName, setPresetName] = useState('')
  const speedRef = useRef<HTMLDivElement | null>(null)
  const speedTriggerRef = useRef<HTMLButtonElement | null>(null)
  const presetPickerRef = useRef<HTMLDivElement | null>(null)
  const presetTriggerRef = useRef<HTMLButtonElement | null>(null)
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
  const equalizer = settings.audio.equalizer
  const selectedPresetValue = equalizer.selectedUserPresetId
    ? `user:${equalizer.selectedUserPresetId}`
    : equalizer.preset
  const selectedPresetName = equalizer.selectedUserPresetId
    ? equalizer.userPresets.find((preset) => preset.id === equalizer.selectedUserPresetId)?.name ?? t('Custom curve')
    : t(EQUALIZER_PRESET_LABELS[equalizer.preset])
  const speedPct = ((p.playbackRate - 0.5) / 1.5) * 100
  const trimmedPresetName = presetName.trim()
  const savedPresetNameExists = equalizer.userPresets.some(
    (preset) => preset.name.toLocaleLowerCase() === trimmedPresetName.toLocaleLowerCase(),
  )
  const canSaveEqualizerPreset = Boolean(trimmedPresetName) &&
    (savedPresetNameExists || equalizer.userPresets.length < MAX_USER_EQUALIZER_PRESETS)

  useEffect(() => {
    setEqualizer(settings.audio.equalizer)
  }, [setEqualizer, settings.audio.equalizer])

  useEffect(() => {
    if (!speedOpen) return
    const onDown = (e: MouseEvent) => {
      if (speedRef.current && !speedRef.current.contains(e.target as Node)) {
        setPresetMenuOpen(false)
        setSpeedOpen(false)
      } else if (presetMenuOpen && presetPickerRef.current && !presetPickerRef.current.contains(e.target as Node)) {
        setPresetMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (presetMenuOpen) {
        setPresetMenuOpen(false)
        presetTriggerRef.current?.focus()
      } else {
        setSpeedOpen(false)
        speedTriggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [speedOpen, presetMenuOpen])

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

  const commitEqualizer = (next: EqualizerSettings) => {
    update({ audio: { equalizer: next } })
    p.setEqualizer(next)
  }

  const setEqualizerPreset = (preset: EqualizerPreset) => {
    const bands: EqualizerBands = preset === 'custom'
      ? [...equalizer.bands] as EqualizerBands
      : [...EQUALIZER_PRESETS[preset]] as EqualizerBands
    commitEqualizer({ ...equalizer, preset, bands, selectedUserPresetId: null })
  }

  const selectEqualizerPreset = (value: string) => {
    setPresetMenuOpen(false)
    presetTriggerRef.current?.focus()
    if (value.startsWith('user:')) {
      const saved = equalizer.userPresets.find((preset) => preset.id === value.slice(5))
      if (!saved) return
      commitEqualizer({
        ...equalizer,
        preset: 'custom',
        bands: [...saved.bands] as EqualizerBands,
        selectedUserPresetId: saved.id,
      })
      return
    }
    setEqualizerPreset(value as EqualizerPreset)
  }

  const setEqualizerBand = (index: number, value: number) => {
    const bands = [...equalizer.bands] as EqualizerBands
    bands[index] = value
    commitEqualizer({ ...equalizer, preset: 'custom', bands, selectedUserPresetId: null })
  }

  const saveEqualizerPreset = () => {
    const name = presetName.trim().slice(0, 32)
    if (!name) return
    const existing = equalizer.userPresets.find((preset) => preset.name.toLocaleLowerCase() === name.toLocaleLowerCase())
    if (!existing && equalizer.userPresets.length >= MAX_USER_EQUALIZER_PRESETS) return
    const id = existing?.id ?? window.crypto.randomUUID()
    const saved = { id, name, bands: [...equalizer.bands] as EqualizerBands }
    const userPresets = existing
      ? equalizer.userPresets.map((preset) => preset.id === id ? saved : preset)
      : [...equalizer.userPresets, saved]
    commitEqualizer({ ...equalizer, preset: 'custom', userPresets, selectedUserPresetId: id })
    setPresetName('')
  }

  const deleteEqualizerPreset = () => {
    if (!equalizer.selectedUserPresetId) return
    setPresetMenuOpen(false)
    commitEqualizer({
      ...equalizer,
      userPresets: equalizer.userPresets.filter((preset) => preset.id !== equalizer.selectedUserPresetId),
      selectedUserPresetId: null,
    })
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
              className={'icon-btn pb-speed-trigger' + (p.playbackRate !== 1 || equalizer.enabled ? ' is-active' : '')}
              ref={speedTriggerRef}
              onClick={() => {
                setSpeedOpen((open) => !open)
                setPresetMenuOpen(false)
              }}
              aria-haspopup="dialog"
              aria-expanded={speedOpen}
              aria-label={t('Playback speed and equalizer')}
              title={t('Playback speed and equalizer')}
            >
              <SlidersHorizontal size={15} />
              <span>{formatPlaybackRate(p.playbackRate)}</span>
            </button>
            {speedOpen && (
              <div className="pb-speed-menu" role="dialog" aria-label={t('Playback speed and equalizer')}>
                <div className="pb-speed-menu-heading">
                  <span>{t('Playback speed')}</span>
                  <strong className="pb-speed-readout">{formatPlaybackRate(p.playbackRate)}</strong>
                  <button
                    className="pb-speed-reset"
                    onClick={() => {
                      p.setPlaybackRate(1)
                    }}
                  >
                    {t('Reset speed')}
                  </button>
                </div>
                <input
                  className="pb-speed-slider"
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.05}
                  list="pb-playback-rate-ticks"
                  value={p.playbackRate}
                  onChange={(e) => p.setPlaybackRate(e.target.valueAsNumber)}
                  style={{ background: `linear-gradient(to right, var(--accent) ${speedPct}%, var(--border) ${speedPct}%)` }}
                  aria-label={t('Playback speed')}
                />
                <datalist id="pb-playback-rate-ticks">
                  {PLAYBACK_RATE_TICKS.map((rate) => <option key={rate} value={rate} />)}
                </datalist>
                <div className="pb-speed-scale" aria-hidden="true">
                  <span>0.5×</span>
                  <span>1×</span>
                  <span>1.5×</span>
                  <span>2×</span>
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

                <div className="pb-speed-divider" />

                <div className="pb-eq-control-row">
                  <div className="pb-eq-preset-picker" ref={presetPickerRef}>
                    <div className="pb-eq-preset-row">
                      <button
                        type="button"
                        className={'pb-eq-preset-trigger' + (presetMenuOpen ? ' is-open' : '')}
                        ref={presetTriggerRef}
                        onClick={() => setPresetMenuOpen((open) => !open)}
                        aria-expanded={presetMenuOpen}
                        aria-controls={presetMenuOpen ? 'pb-eq-preset-list' : undefined}
                        aria-label={`${t('Equalizer preset')}: ${selectedPresetName}`}
                      >
                        <span className="pb-eq-preset-name">{selectedPresetName}</span>
                        <PresetCurve bands={equalizer.bands} />
                        <ChevronDown size={14} className="pb-eq-preset-chevron" aria-hidden="true" />
                      </button>
                      {equalizer.selectedUserPresetId ? (
                        <button
                          className="icon-btn pb-eq-delete"
                          onClick={deleteEqualizerPreset}
                          aria-label={t('Delete saved preset')}
                          title={t('Delete saved preset')}
                        >
                          <Trash2 size={14} />
                        </button>
                      ) : null}
                    </div>
                    {presetMenuOpen ? (
                      <div className="pb-eq-preset-list" id="pb-eq-preset-list">
                        {EQUALIZER_PRESET_KEYS.map((preset) => (
                          <button
                            type="button"
                            key={preset}
                            className={'pb-eq-preset-option' + (selectedPresetValue === preset ? ' is-selected' : '')}
                            aria-pressed={selectedPresetValue === preset}
                            onClick={() => selectEqualizerPreset(preset)}
                          >
                            <span className="pb-eq-preset-name">{t(EQUALIZER_PRESET_LABELS[preset])}</span>
                            <PresetCurve bands={preset === 'custom' ? equalizer.bands : EQUALIZER_PRESETS[preset]} />
                            {selectedPresetValue === preset ? <Check size={13} /> : <span className="pb-eq-preset-check" />}
                          </button>
                        ))}
                        {equalizer.userPresets.length > 0 ? (
                          <div className="pb-eq-preset-group">{t('Saved presets')}</div>
                        ) : null}
                        {equalizer.userPresets.map((preset) => (
                          <button
                            type="button"
                            key={preset.id}
                            className={'pb-eq-preset-option' + (selectedPresetValue === `user:${preset.id}` ? ' is-selected' : '')}
                            aria-pressed={selectedPresetValue === `user:${preset.id}`}
                            onClick={() => selectEqualizerPreset(`user:${preset.id}`)}
                          >
                            <span className="pb-eq-preset-name">{preset.name}</span>
                            <PresetCurve bands={preset.bands} />
                            {selectedPresetValue === `user:${preset.id}` ? <Check size={13} /> : <span className="pb-eq-preset-check" />}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <button
                    className={equalizer.enabled ? 'switch is-on' : 'switch'}
                    role="switch"
                    aria-checked={equalizer.enabled}
                    aria-label={t('Enable equalizer')}
                    onClick={() => commitEqualizer({ ...equalizer, enabled: !equalizer.enabled })}
                  />
                </div>

                <div className="pb-eq-bands">
                  {EQUALIZER_BANDS.map((band, index) => {
                    const value = equalizer.bands[index]
                    const percent = ((value - EQUALIZER_MIN_DB) / (EQUALIZER_MAX_DB - EQUALIZER_MIN_DB)) * 100
                    const fill = value >= 0
                      ? `linear-gradient(to right, var(--border) 0%, var(--border) 50%, var(--accent) 50%, var(--accent) ${percent}%, var(--border) ${percent}%, var(--border) 100%)`
                      : `linear-gradient(to right, var(--border) 0%, var(--border) ${percent}%, var(--accent) ${percent}%, var(--accent) 50%, var(--border) 50%, var(--border) 100%)`
                    const shortFrequency = band.frequency >= 1000 ? `${band.frequency / 1000}k` : String(band.frequency)
                    return (
                      <div className="pb-eq-band" key={band.frequency}>
                        <span className="pb-eq-value">{value > 0 ? '+' : ''}{value}</span>
                        <div className="pb-eq-track">
                          <span className="pb-eq-zero" aria-hidden="true" />
                          <input
                            className="pb-eq-slider"
                            type="range"
                            min={EQUALIZER_MIN_DB}
                            max={EQUALIZER_MAX_DB}
                            step={1}
                            value={value}
                            onChange={(e) => setEqualizerBand(index, e.target.valueAsNumber)}
                            style={{ background: fill }}
                            aria-label={t(band.label)}
                            aria-valuetext={`${value > 0 ? '+' : ''}${value} dB`}
                          />
                        </div>
                        <span className="pb-eq-frequency">{shortFrequency}</span>
                      </div>
                    )
                  })}
                </div>

                <div className="pb-eq-save-row">
                  <input
                    className="text-input pb-eq-name"
                    value={presetName}
                    maxLength={32}
                    placeholder={t('Preset name')}
                    onChange={(e) => setPresetName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveEqualizerPreset() }}
                    aria-label={t('Preset name')}
                  />
                  <button
                    className="btn pb-eq-save"
                    disabled={!canSaveEqualizerPreset}
                    onClick={saveEqualizerPreset}
                  >
                    {t('Save')}
                  </button>
                </div>
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
