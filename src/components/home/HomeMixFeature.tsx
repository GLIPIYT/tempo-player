import { useEffect, useRef, useState, type FocusEvent, type MouseEvent } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, Clock3, ListMusic, Play } from 'lucide-react'
import type { Track } from '../../types/models'
import { resolveLang, useT } from '../../i18n'
import { formatCount } from '../../i18n/count'
import { useSettings } from '../../state/settings'
import type { HourMix } from '../../utils/hourMixes'
import Cover from '../common/Cover'

interface HomeMixFeatureProps {
  mixes: HourMix[]
  onPlay: (tracks: Track[], index: number) => void
  onOpen: (mix: HourMix) => void
  onMixMenu: (event: MouseEvent, mix: HourMix) => void
  onSectionMenu: (event: MouseEvent) => void
}

function mixCover(mix: HourMix): string | null {
  return mix.tracks.find((track) => track.coverPath)?.coverPath ?? null
}

export default function HomeMixFeature({
  mixes,
  onPlay,
  onOpen,
  onMixMenu,
  onSectionMenu,
}: HomeMixFeatureProps) {
  const t = useT()
  const { settings } = useSettings()
  const lang = resolveLang(settings.lang)
  const sectionRef = useRef<HTMLElement>(null)
  const pickerButtonRef = useRef<HTMLButtonElement>(null)
  const firstChoiceRef = useRef<HTMLButtonElement>(null)
  const pointerInput = useRef(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [visible, setVisible] = useState(!document.hidden)
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [manualUntil, setManualUntil] = useState(0)

  const activeIndex = Math.max(0, mixes.findIndex((mix) => mix.key === selectedKey))
  const activeMix = mixes[activeIndex]
  const mixKeys = mixes.map((mix) => mix.key).join('\u0001')

  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden)
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onMotion = () => setReducedMotion(motionQuery.matches)
    const onPointerInput = () => { pointerInput.current = true }
    const onKeyInput = () => { pointerInput.current = false }
    document.addEventListener('visibilitychange', onVisibility)
    document.addEventListener('pointerdown', onPointerInput)
    document.addEventListener('keydown', onKeyInput)
    motionQuery.addEventListener('change', onMotion)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      document.removeEventListener('pointerdown', onPointerInput)
      document.removeEventListener('keydown', onKeyInput)
      motionQuery.removeEventListener('change', onMotion)
    }
  }, [])

  useEffect(() => {
    const keys = mixKeys ? mixKeys.split('\u0001') : []
    if (keys.length < 2 || hovered || focused || pickerOpen || !visible || reducedMotion) return
    const delay = Math.max(3000, manualUntil - Date.now())
    const timer = window.setTimeout(() => {
      setSelectedKey((current) => {
        const index = Math.max(0, keys.indexOf(current ?? keys[0]))
        return keys[(index + 1) % keys.length]
      })
      setManualUntil(0)
    }, delay)
    return () => window.clearTimeout(timer)
  }, [mixKeys, selectedKey, hovered, focused, pickerOpen, visible, reducedMotion, manualUntil])

  useEffect(() => {
    if (!pickerOpen) return
    firstChoiceRef.current?.focus()
    const onOutsidePointer = (event: PointerEvent) => {
      if (!sectionRef.current?.contains(event.target as Node)) setPickerOpen(false)
    }
    document.addEventListener('pointerdown', onOutsidePointer)
    return () => document.removeEventListener('pointerdown', onOutsidePointer)
  }, [pickerOpen])

  if (!activeMix) return null

  const chooseMix = (index: number) => {
    if (pickerOpen) pickerButtonRef.current?.focus()
    setSelectedKey(mixes[(index + mixes.length) % mixes.length].key)
    setManualUntil(Date.now() + 9000)
    setPickerOpen(false)
  }

  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false)
  }

  return (
    <section
      ref={sectionRef}
      className="home-mix-feature"
      aria-label={t('For this hour')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(!pointerInput.current)}
      onBlurCapture={onBlur}
      onPointerDownCapture={() => setFocused(false)}
      onKeyDown={(event) => {
        setFocused(true)
        if (event.key === 'Escape') {
          if (pickerOpen) pickerButtonRef.current?.focus()
          setPickerOpen(false)
        }
      }}
    >
      <div className={`home-mix-stage${pickerOpen ? ' is-picker-open' : ''}`} onContextMenu={onSectionMenu}>
        {mixes.map((mix, index) => {
          const current = index === activeIndex
          const art = mixCover(mix)
          const covers = mix.tracks.slice(0, 3)
          return (
            <article
              key={mix.key}
              className={`home-mix-slide${current ? ' is-active' : ''}`}
              aria-hidden={!current || pickerOpen}
              onContextMenu={(event) => onMixMenu(event, mix)}
            >
              <div className="home-mix-copy">
                <span className="home-mix-kicker">
                  <Clock3 size={14} />
                  {mix.key === 'mix' ? t('For this hour') : t('Artist mix')}
                </span>
                <h2>{mix.key === 'mix' ? t('Music for this hour') : mix.title}</h2>
                <p>
                  {mix.key === 'mix'
                    ? t('Picked from what you usually play around this time of day')
                    : t('Tracks by this artist in your hourly picks')}
                </p>
                <div className="home-mix-actions">
                  <button type="button" className="home-mix-play" tabIndex={current && !pickerOpen ? 0 : -1} onClick={() => onPlay(mix.tracks, 0)}>
                    <Play size={15} fill="currentColor" />
                    {t('Play mix')}
                  </button>
                  <button
                    type="button"
                    className="home-mix-view"
                    tabIndex={current && !pickerOpen ? 0 : -1}
                    onClick={() => onOpen(mix)}
                  >
                    <ListMusic size={15} />
                    {t('View tracks')}
                  </button>
                </div>
                <span className="home-mix-meta">{formatCount(mix.tracks.length, 'track', t, lang)} · {t('From your library')}</span>
              </div>
              <div className="home-mix-art" aria-hidden="true">
                <div className="home-mix-art-back"><Cover path={art} label={mix.title} size={360} loading="eager" /></div>
                {covers.map((track, coverIndex) => (
                  <span key={`${track.id}:${coverIndex}`} className={`home-mix-art-card is-card-${coverIndex}`}>
                    <Cover path={track.coverPath} label={track.title} size={228} loading="eager" />
                  </span>
                ))}
              </div>
            </article>
          )
        })}
        <div className="home-mix-picker" id="home-mix-picker" aria-hidden={!pickerOpen}>
            <div className="home-mix-picker-heading"><strong>{t('All mixes')}</strong><span>{t('Choose a mix')}</span></div>
            <div className={`home-mix-picker-rail${mixes.length < 4 ? ' is-short' : ''}`}>
              {mixes.map((mix, index) => (
                <button
                  key={mix.key}
                  ref={index === 0 ? firstChoiceRef : undefined}
                  type="button"
                  className="home-mix-choice"
                  tabIndex={pickerOpen ? 0 : -1}
                  aria-current={index === activeIndex ? 'true' : undefined}
                  onClick={() => chooseMix(index)}
                  onContextMenu={(event) => onMixMenu(event, mix)}
                >
                  <Cover path={mixCover(mix)} label={mix.title} size={146} />
                  <span className="home-mix-choice-copy">
                    <small>{mix.key === 'mix' ? t('For this hour') : t('Artist mix')}</small>
                    <strong>{mix.key === 'mix' ? t('Music for this hour') : mix.title}</strong>
                    <span>{formatCount(mix.tracks.length, 'track', t, lang)}</span>
                  </span>
                </button>
              ))}
            </div>
        </div>
        <div className="home-mix-controls">
          <button
            ref={pickerButtonRef}
            type="button"
            className="home-mix-picker-button"
            aria-expanded={pickerOpen}
            aria-controls="home-mix-picker"
            onClick={() => {
              setPickerOpen((open) => !open)
            }}
          >
            <span className="home-mix-stack" aria-hidden="true">
              {mixes.slice(0, 3).map((mix) => <Cover key={mix.key} path={mixCover(mix)} label={mix.title} size={24} />)}
            </span>
            <span>{t('All mixes')}</span>
            <span className="home-mix-count">{mixes.length}</span>
            <ChevronDown size={14} className={pickerOpen ? 'is-open' : undefined} />
          </button>
          {mixes.length > 1 && !pickerOpen ? (
            <div className="home-mix-navigation" aria-label={t('Choose a mix')}>
              <button type="button" aria-label={t('Previous mix')} onClick={() => chooseMix(activeIndex - 1)}><ChevronLeft size={17} /></button>
              <div className="home-mix-dots">
                {mixes.map((mix, index) => (
                  <button
                    key={mix.key}
                    type="button"
                    aria-label={`${t('Show mix')}: ${mix.title}`}
                    aria-pressed={index === activeIndex}
                    onClick={() => chooseMix(index)}
                  />
                ))}
              </div>
              <button type="button" aria-label={t('Next mix')} onClick={() => chooseMix(activeIndex + 1)}><ChevronRight size={17} /></button>
            </div>
          ) : null}
        </div>
      </div>

    </section>
  )
}
