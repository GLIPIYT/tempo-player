import { useEffect, useRef, useState, type FocusEvent, type MouseEvent } from 'react'
import { ChevronLeft, ChevronRight, Clock3, ListMusic, Play, Plus } from 'lucide-react'
import type { Track } from '../../types/models'
import { resolveLang, useT } from '../../i18n'
import { formatCount } from '../../i18n/count'
import { useSettings } from '../../state/settings'
import type { HourMix } from '../../utils/hourMixes'
import Cover from '../common/Cover'
import { useMixReorder } from './useMixReorder'
import './homeMixFeature.css'

interface HomeMixFeatureProps {
  mixes: HourMix[]
  onPlay: (tracks: Track[], index: number) => void
  onOpen: (mix: HourMix) => void
  onMixMenu: (event: MouseEvent, mix: HourMix) => void
  onSectionMenu: (event: MouseEvent) => void
  onCreateRule: () => void
  onReorder: (keys: string[]) => void
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
  onCreateRule,
  onReorder,
}: HomeMixFeatureProps) {
  const t = useT()
  const { settings } = useSettings()
  const lang = resolveLang(settings.lang)
  const sectionRef = useRef<HTMLElement>(null)
  const dockToggleRef = useRef<HTMLButtonElement>(null)
  const heroPlayRef = useRef<HTMLButtonElement>(null)
  const pointerInput = useRef(false)
  const [slide, setSlide] = useState<{ selected: string | null; previous: string | null }>({ selected: null, previous: null })
  const [dockOpen, setDockOpen] = useState(false)
  const [dockFocused, setDockFocused] = useState(false)
  const [dockHovered, setDockHovered] = useState(false)
  const [dockHoverDismissed, setDockHoverDismissed] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [visible, setVisible] = useState(!document.hidden)
  const [inViewport, setInViewport] = useState(true)
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [manualUntil, setManualUntil] = useState(0)
  const reorder = useMixReorder(mixes.map(mix => mix.key), onReorder, reducedMotion)

  const activeIndex = Math.max(0, mixes.findIndex((mix) => mix.key === slide.selected))
  const activeMix = mixes[activeIndex]
  const nextMix = mixes[(activeIndex + 1) % mixes.length]
  const mixKeys = mixes.map((mix) => mix.key).join('\u0001')
  const dockExpanded = dockOpen || dockFocused || reorder.draggingKey !== null || (dockHovered && !dockHoverDismissed)

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
    const target = sectionRef.current
    if (!target || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => setInViewport(entry?.isIntersecting ?? false), { threshold: 0.1 })
    observer.observe(target)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const keys = mixKeys ? mixKeys.split('\u0001') : []
    if (keys.length < 2 || hovered || focused || !visible || !inViewport || reducedMotion) return
    const delay = Math.max(3000, manualUntil - Date.now())
    const timer = window.setTimeout(() => {
      setSlide((current) => {
        const index = Math.max(0, keys.indexOf(current.selected ?? keys[0]))
        return { selected: keys[(index + 1) % keys.length], previous: keys[index] }
      })
      setManualUntil(0)
    }, delay)
    return () => window.clearTimeout(timer)
  }, [mixKeys, slide.selected, hovered, focused, visible, inViewport, reducedMotion, manualUntil])

  useEffect(() => {
    if (!slide.previous) return
    const timer = window.setTimeout(() => setSlide(current => ({ ...current, previous: null })), reducedMotion ? 0 : 620)
    return () => window.clearTimeout(timer)
  }, [slide.previous, slide.selected, reducedMotion])

  if (!activeMix) return <section ref={sectionRef} className="home-mix-feature home-mix-feature--b"><button className="btn" onClick={onCreateRule}><Plus size={16} />{t('Your rule')}</button></section>

  const chooseMix = (index: number) => {
    const selected = mixes[(index + mixes.length) % mixes.length].key
    if (selected !== activeMix.key) setSlide({ selected, previous: activeMix.key })
    setManualUntil(Date.now() + 9000)
  }

  const onBlur = (event: FocusEvent<HTMLElement>) => {
    const relatedTarget = event.relatedTarget as Node | null
    if (!event.currentTarget.contains(relatedTarget)) setFocused(false)
  }

  const focusAfterDockClose = () => {
    if (heroPlayRef.current?.disabled) dockToggleRef.current?.focus()
    else heroPlayRef.current?.focus()
  }

  return (
    <section
      ref={sectionRef}
      className="home-mix-feature home-mix-feature--b"
      aria-label={t('All mixes')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(!pointerInput.current)}
      onBlurCapture={onBlur}
      onPointerDownCapture={() => {
        setFocused(false)
        setDockFocused(false)
      }}
      onKeyDown={(event) => {
        setFocused(true)
        if (event.key === 'Escape' && dockExpanded) {
          event.preventDefault()
          event.stopPropagation()
          setDockOpen(false)
          setDockFocused(false)
          setDockHoverDismissed(true)
          focusAfterDockClose()
        }
      }}
    >
      <div className={`home-mix-layout${dockExpanded ? ' is-dock-expanded' : ''}`}>
        <div className="home-mix-stage home-mix-stage--b" onContextMenu={onSectionMenu}>
          {mixes.map((mix, index) => {
            const current = index === activeIndex
            const leaving = !current && mix.key === slide.previous
            if (!current && mix !== nextMix && !leaving) return null
            const art = mixCover(mix)
            const covers = mix.tracks.slice(0, 3)
            return (
              <article
                key={mix.key}
                className={`home-mix-slide${current ? ' is-active' : ''}${leaving ? ' is-leaving' : ''}`}
                aria-hidden={!current}
                onContextMenu={(event) => onMixMenu(event, mix)}
              >
                <div className="home-mix-copy">
                  <span className="home-mix-kicker">
                    <Clock3 size={14} />
                    {mix.kind === 'custom' ? t('Custom mix') : mix.kind === 'hour' ? t('For this hour') : mix.kind === 'artist' ? t('Artist mix') : t('From your library')}
                  </span>
                  <h2>{mix.kind === 'hour' ? t('Music for this hour') : mix.title}</h2>
                  {mix.description ? <p>{mix.kind === 'custom' ? mix.description : t(mix.description)}</p> : null}
                  <div className="home-mix-actions">
                    <button ref={current ? heroPlayRef : undefined} type="button" className="home-mix-play" disabled={!mix.tracks.length} tabIndex={current ? 0 : -1} onClick={() => onPlay(mix.tracks, 0)}>
                      <Play size={15} fill="currentColor" />
                      {t('Play mix')}
                    </button>
                    <button
                      type="button"
                      className="home-mix-view"
                      tabIndex={current ? 0 : -1}
                      onClick={() => onOpen(mix)}
                    >
                      <ListMusic size={15} />
                      {t('View tracks')}
                    </button>
                  </div>
                  <span className="home-mix-meta">{formatCount(mix.tracks.length, 'track', t, lang)}{mix.kind !== 'custom' ? ` · ${t('From your library')}` : ''}</span>
                </div>
                <div className="home-mix-art" aria-hidden="true">
                  <div className="home-mix-art-back"><Cover path={art} label={mix.title} size={128} loading={current ? 'eager' : 'lazy'} thumbnailOnly /></div>
                  {covers.map((track, coverIndex) => (
                    <span key={`${track.id}:${coverIndex}`} className={`home-mix-art-card is-card-${coverIndex}`}>
                      <Cover path={track.coverPath} label={track.title} size={228} loading={current ? 'eager' : 'lazy'} fetchPriority={current && coverIndex === 0 ? 'high' : 'auto'} />
                    </span>
                  ))}
                </div>
              </article>
            )
          })}
          {mixes.length > 1 ? (
            <div className="home-mix-controls">
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
            </div>
          ) : null}
        </div>
        <div className="home-mix-dock-slot">
          <div
            className={`home-mix-dock${dockExpanded ? ' is-expanded' : ''}`}
            onFocusCapture={() => {
              if (!pointerInput.current) setDockFocused(true)
            }}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDockFocused(false)
            }}
            onPointerEnter={(event) => {
              if (event.pointerType === 'mouse') {
                setDockHovered(true)
                setDockHoverDismissed(false)
              }
            }}
            onPointerLeave={(event) => {
              if (event.pointerType === 'mouse') {
                setDockHovered(false)
                setDockHoverDismissed(false)
              }
            }}
          >
            <button
              ref={dockToggleRef}
              type="button"
              className="home-mix-dock-toggle"
              aria-label={dockExpanded ? t('Collapse mix list') : t('Expand mix list')}
              aria-expanded={dockExpanded}
              aria-controls="home-mix-dock-list"
              onClick={() => {
                setDockOpen(!dockExpanded)
                if (dockExpanded) {
                  setDockFocused(false)
                  setDockHoverDismissed(true)
                }
              }}
            >
              {dockExpanded ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </button>
            <div
              ref={reorder.railRef}
              {...reorder.railHandlers}
              className={`home-mix-dock-list${reorder.draggingKey ? ' is-reordering' : ''}`}
              id="home-mix-dock-list"
              role="group"
              aria-label={t('Choose a mix')}
            >
              <span ref={reorder.slotRef} className="home-mix-drop-slot" aria-hidden="true" />
              {mixes.map((mix, index) => {
                const title = mix.kind === 'hour' ? t('Music for this hour') : mix.title
                const kind = mix.kind === 'custom' ? t('Custom mix') : mix.kind === 'hour' ? t('For this hour') : mix.kind === 'artist' ? t('Artist mix') : t('From your library')
                const description = mix.kind === 'custom' ? mix.description : t(mix.description)
                return (
                  <button
                    key={mix.key}
                    type="button"
                    className={`home-mix-dock-choice${reorder.draggingKey === mix.key ? ' is-dragging' : ''}`}
                    data-mix-key={mix.key}
                    aria-label={`${title}, ${kind}, ${formatCount(mix.tracks.length, 'track', t, lang)}`}
                    aria-pressed={index === activeIndex}
                    title={dockExpanded ? t('Drag to reorder. Alt + arrow keys also move the mix.') : title}
                    onPointerDown={(event) => {
                      if (dockExpanded) reorder.onPointerDown(event, mix.key)
                    }}
                    onDragStart={(event) => event.preventDefault()}
                    onClick={() => chooseMix(index)}
                    onContextMenu={(event) => {
                      if (reorder.draggingKey) {
                        event.preventDefault()
                        return
                      }
                      onMixMenu(event, mix)
                    }}
                  >
                    <span className="home-mix-dock-art"><Cover path={mixCover(mix)} label={title} size={38} loading={index === activeIndex ? 'eager' : 'lazy'} fetchPriority={index === activeIndex ? 'auto' : 'low'} thumbnailOnly /></span>
                    <span className="home-mix-dock-copy">
                      <strong>{title}</strong>
                      <small>{kind} · {formatCount(mix.tracks.length, 'track', t, lang)}</small>
                      <span>{description}</span>
                    </span>
                    <ChevronRight size={15} className="home-mix-dock-arrow" aria-hidden="true" />
                  </button>
                )
              })}
            </div>
            <button type="button" className="home-mix-dock-create" onClick={onCreateRule}>
              <Plus size={16} />
              <span>{t('Your rule')}</span>
            </button>
          </div>
        </div>
      </div>

    </section>
  )
}
