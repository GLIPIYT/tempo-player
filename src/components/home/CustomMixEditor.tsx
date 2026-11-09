import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  TimerReset,
  ListMusic,
  Copy,
  Ellipsis,
  Folder,
  History,
  ListFilter,
  Music2,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { api } from '../../api/client'
import type { Artist } from '../../types/models'
import type { CustomMixRule } from '../../features/mixes/types'
import { createCustomMixRule } from '../../features/mixes/types'
import { useT } from '../../i18n'
import { useSettings } from '../../state/settings'
import Cover from '../common/Cover'
import BrandIcon from '../common/BrandIcon'
import './customMixEditor.css'

export interface MixRulePreset {
  name: string
  rule: CustomMixRule
  cover?: string | null
}
const COMMON_GENRES = [
  'Alternative Rock',
  'Ambient',
  'Classical',
  'Country',
  'Dance & EDM',
  'Dancehall',
  'Deep House',
  'Disco',
  'Drum & Bass',
  'Dubstep',
  'Electronic',
  'Folk & Singer-Songwriter',
  'Hip Hop & Rap',
  'House',
  'Indie',
  'Jazz & Blues',
  'Latin',
  'Metal',
  'Piano',
  'Pop',
  'R&B & Soul',
  'Reggae',
  'Reggaeton',
  'Rock',
  'Soundtrack',
  'Techno',
  'Trance',
  'Trap',
  'Trip Hop',
  'World',
]
const time = (n: number) =>
  `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`

function Mode({
  value,
  onChange,
}: {
  value: 'allow' | 'deny'
  onChange: (value: 'allow' | 'deny') => void
}) {
  const t = useT()
  return (
    <div
      className={`mix-rule-mode ${value}`}
      role="group"
      aria-label={t('List mode')}
    >
      <span aria-hidden="true" />
      <button
        type="button"
        aria-pressed={value === 'allow'}
        onClick={() => onChange('allow')}
      >
        {t('Whitelist')}
      </button>
      <button
        type="button"
        aria-pressed={value === 'deny'}
        onClick={() => onChange('deny')}
      >
        {t('Blacklist')}
      </button>
    </div>
  )
}

function Range({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  disabled,
  format = (n) => `${n}%`,
  onChange,
}: {
  label: string
  value: [number, number]
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  format?: (value: number) => string
  onChange: (value: [number, number]) => void
}) {
  const [dragging, setDragging] = useState<number | null>(null)
  const style = {
    '--range-from': `${((value[0] - min) / (max - min)) * 100}%`,
    '--range-to': `${((value[1] - min) / (max - min)) * 100}%`,
  } as CSSProperties
  return (
    <div
      className={`mix-rule-range${disabled ? ' is-disabled' : ''}${dragging !== null ? ' is-dragging' : ''}`}
      style={style}
    >
      <div className="mix-rule-range-rail">
        <i />
      </div>
      {value.map((n, index) => (
        <input
          key={index}
          type="range"
          min={min}
          max={max}
          step={step}
          value={n}
          disabled={disabled}
          aria-label={`${label}: ${index === 0 ? 'minimum' : 'maximum'}`}
          aria-valuetext={format(n)}
          style={{
            zIndex:
              dragging === index
                ? 4
                : index === 0 && value[0] === max
                  ? 3
                  : index + 1,
          }}
          onPointerDown={() => setDragging(index)}
          onPointerUp={() => setDragging(null)}
          onPointerCancel={() => setDragging(null)}
          onBlur={() => setDragging(null)}
          onChange={(event) => {
            const next: [number, number] = [...value]
            next[index] =
              index === 0
                ? Math.min(+event.target.value, value[1])
                : Math.max(+event.target.value, value[0])
            onChange(next)
          }}
        />
      ))}
      <div className="mix-rule-range-labels" aria-hidden="true">
        {value.map((n, i) => (
          <span
            key={i}
            className={dragging === i ? 'is-active' : ''}
            style={{ left: `${((n - min) / (max - min)) * 100}%` }}
          >
            {format(n)}
          </span>
        ))}
      </div>
      <div className="mix-rule-range-value">
        {format(value[0])} <span>—</span> {format(value[1])}
      </div>
    </div>
  )
}

interface Option {
  id: string
  name: string
  icon?: ReactNode
  avatar?: string | null
  artist?: boolean
}
function SingleRange({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (value: number) => string
  onChange: (value: number) => void
}) {
  return (
    <div
      className="mix-rule-range mix-rule-single"
      style={
        {
          '--range-from': '0%',
          '--range-to': `${((value - min) / (max - min)) * 100}%`,
        } as CSSProperties
      }
    >
      <div className="mix-rule-range-rail">
        <i />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        aria-valuetext={format(value)}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output className="mix-rule-range-value">{format(value)}</output>
    </div>
  )
}
function MultiSelect({
  label,
  options,
  values,
  onChange,
  mode,
}: {
  label: string
  options: Option[]
  values: string[]
  onChange: (values: string[]) => void
  mode?: ReactNode
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [menuRoot, setMenuRoot] = useState<HTMLElement | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    search.current?.focus()
    const outside = (e: PointerEvent) => {
      if (
        !host.current?.contains(e.target as Node) &&
        !popup.current?.contains(e.target as Node)
      )
        setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  useLayoutEffect(() => {
    if (!open || !menuRoot) return
    const anchor = host.current
    const menu = popup.current
    if (!anchor || !menu) return
    const position = () => {
      const rect = anchor.getBoundingClientRect()
      const parent = menuRoot.getBoundingClientRect()
      const scale = parent.width / menuRoot.offsetWidth || 1
      Object.assign(menu.style, {
        left: `${(rect.left - parent.left) / scale - menuRoot.clientLeft}px`,
        top: `${(rect.bottom - parent.top) / scale - menuRoot.clientTop + 6}px`,
        width: `${rect.width / scale}px`,
        maxHeight: `${Math.max(60, (window.innerHeight - rect.bottom - 16) / scale - 6)}px`,
      })
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(anchor)
    observer.observe(menuRoot)
    menuRoot.addEventListener('scroll', position, true)
    window.addEventListener('resize', position)
    return () => {
      observer.disconnect()
      menuRoot.removeEventListener('scroll', position, true)
      window.removeEventListener('resize', position)
    }
  }, [open, menuRoot])
  const toggle = (id: string) =>
    onChange(
      values.includes(id) ? values.filter((v) => v !== id) : [...values, id],
    )
  const visible = options.filter((o) =>
    o.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  )
  return (
    <div
      className="mix-rule-select"
      ref={host}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation()
          setOpen(false)
          host.current
            ?.querySelector<HTMLButtonElement>('.mix-rule-select-trigger')
            ?.focus()
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const buttons = [
            ...(popup.current?.querySelectorAll<HTMLButtonElement>(
              '.mix-rule-option',
            ) ?? []),
          ]
          if (buttons.length) {
            e.preventDefault()
            const current = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            )
            buttons[
              (current + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) %
                buttons.length
            ]?.focus()
          }
        }
      }}
    >
      {mode}
      <div className="mix-rule-select-field">
        <div className="mix-rule-chips">
          {values.map((value) => {
            const option = options.find((o) => o.id === value)
            return option ? (
              <button
                type="button"
                key={value}
                className={`mix-rule-chip${option.artist ? ' has-avatar' : ''}`}
                title={`${t('Remove')}: ${option.name}`}
                onClick={() => toggle(value)}
              >
                <span className="mix-rule-chip-remove">
                  <X size={11} />
                </span>
                {option.artist ? (
                  <span className="mix-rule-avatar">
                    <Cover
                      path={option.avatar}
                      label={option.name}
                      size={20}
                      rounded
                    />
                    <X size={12} />
                  </span>
                ) : (
                  option.icon
                )}
                <span>{option.name}</span>
              </button>
            ) : null
          })}
        </div>
        <button
          className="mix-rule-select-trigger"
          type="button"
          aria-label={label}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => {
            const rect = host.current?.getBoundingClientRect()
            const root =
              host.current?.closest<HTMLElement>('.mix-rule-dialog') ?? null
            const body = host.current?.closest<HTMLElement>('.mix-rule-body')
            if (
              !open &&
              rect &&
              root &&
              body &&
              window.innerHeight - rect.bottom < 220
            ) {
              const scale =
                root.getBoundingClientRect().width / root.offsetWidth || 1
              body.scrollBy({
                top: (220 - (window.innerHeight - rect.bottom)) / scale,
                behavior: window.matchMedia('(prefers-reduced-motion: reduce)')
                  .matches
                  ? 'instant'
                  : 'smooth',
              })
            }
            setMenuRoot(root)
            setOpen((v) => !v)
          }}
        >
          {!values.length ? <span>{t('Choose…')}</span> : <Plus size={14} />}
          <ChevronDown size={14} className={open ? 'is-open' : ''} />
        </button>
      </div>
      {open && menuRoot
        ? createPortal(
            <div className="mix-rule-select-menu" ref={popup} id={id}>
              <div className="mix-rule-select-search">
                <Search size={14} />
                <input
                  ref={search}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('Search')}
                  aria-label={t('Search')}
                />
              </div>
              <div className="mix-rule-options" role="group" aria-label={label}>
                {visible.map((option) => (
                  <button
                    type="button"
                    key={option.id}
                    className="mix-rule-option"
                    aria-pressed={values.includes(option.id)}
                    onClick={() => toggle(option.id)}
                  >
                    {option.artist ? (
                      <Cover
                        path={option.avatar}
                        label={option.name}
                        size={26}
                        rounded
                      />
                    ) : (
                      option.icon
                    )}
                    <span>{option.name}</span>
                    {values.includes(option.id) ? <Check size={14} /> : null}
                  </button>
                ))}
                {!visible.length ? (
                  <span className="mix-rule-select-empty">
                    {t('No results')}
                  </span>
                ) : null}
              </div>
            </div>,
            menuRoot,
          )
        : null}
    </div>
  )
}

export default function CustomMixEditor({
  initial,
  presets,
  genres,
  onSave,
  onDelete,
  onClose,
}: {
  initial?: CustomMixRule
  presets: MixRulePreset[]
  genres: string[]
  onSave: (rule: CustomMixRule) => Promise<void>
  onDelete?: () => Promise<void>
  onClose: () => void
}) {
  const t = useT()
  const { settings } = useSettings()
  const scale = Math.max(50, Math.min(200, settings.font.uiScalePct)) / 100
  const [rule, setRule] = useState<CustomMixRule>(() =>
    structuredClone(
      initial ?? {
        ...createCustomMixRule(),
        genrePercent: [15, 30],
        forgottenPercent: [30, 60],
      },
    ),
  )
  const [artists, setArtists] = useState<Artist[]>([])
  const [artistError, setArtistError] = useState(false)
  const [closing, setClosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [menu, setMenu] = useState(false)
  const [copyOpen, setCopyOpen] = useState(false)
  const [descriptionMode, setDescriptionMode] = useState(false)
  const nameInput = useRef<HTMLInputElement>(null)
  const descriptionInput = useRef<HTMLTextAreaElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const nested = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()
  const nameId = useId()
  const fieldId = useId()
  const close = () => {
    if (busy || closing) return
    setClosing(true)
    closeTimer.current = setTimeout(onClose, 170)
  }
  useEffect(() => {
    let cancelled = false
    void api
      .listArtists('')
      .then((a) => {
        if (!cancelled) setArtists(a)
      })
      .catch(() => {
        if (!cancelled) setArtistError(true)
      })
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLInputElement>('input')?.focus()
    return () => {
      cancelled = true
      clearTimeout(closeTimer.current)
      previous?.focus()
    }
  }, [])
  useEffect(() => {
    if (!copyOpen) return
    nested.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const returnFocus = dialog.current?.querySelector<HTMLButtonElement>(
      '.mix-rule-header-actions > button',
    )
    return () => returnFocus?.focus()
  }, [copyOpen])
  useEffect(() => {
    if (descriptionMode) descriptionInput.current?.focus()
    else nameInput.current?.focus()
  }, [descriptionMode])
  const genreOptions = useMemo(
    () =>
      [
        ...new Set(
          [...COMMON_GENRES, ...genres, ...rule.genres].filter(Boolean),
        ),
      ]
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({ id: name, name })),
    [genres, rule.genres],
  )
  const change = (next: Partial<CustomMixRule>) =>
    setRule((current) => ({ ...current, ...next }))
  const submit = async () => {
    if (busy || closing || !rule.name.trim() || !rule.sources.length) return
    setBusy(true)
    setError('')
    try {
      await onSave({ ...rule, name: rule.name.trim() })
      setClosing(true)
      closeTimer.current = setTimeout(onClose, 170)
    } catch (e) {
      setError(String(e))
      setBusy(false)
    }
  }
  const field = (
    label: string,
    icon: ReactNode,
    control: ReactNode,
    wide = false,
  ) => (
    <section className={`mix-rule-field${wide ? ' is-wide' : ''}`}>
      <h3>
        {icon}
        {t(label)}
      </h3>
      {control}
    </section>
  )
  return createPortal(
    <div
      className={`mix-rule-backdrop${closing ? ' is-closing' : ''}`}
      style={{ '--mix-rule-scale': scale } as CSSProperties}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          if (copyOpen) setCopyOpen(false)
          else close()
        }
      }}
    >
      <div
        className="mix-rule-dialog"
        style={{ zoom: scale }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={nameId}
        ref={dialog}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            if (copyOpen) setCopyOpen(false)
            else if (menu) setMenu(false)
            else close()
          }
          if (e.key === 'Tab') {
            const scope = copyOpen ? nested.current : dialog.current
            const nodes = [
              ...(scope?.querySelectorAll<HTMLElement>(
                'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
              ) ?? []),
            ].filter((el) => el.offsetParent !== null)
            const first = nodes[0],
              last = nodes.at(-1)
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault()
              last?.focus()
            }
            if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault()
              first?.focus()
            }
          }
        }}
      >
        <header>
          <div>
            <span className="mix-rule-eyebrow">
              <ListFilter size={13} />
              {t('Custom mix')}
            </span>
            <h2 id={nameId}>{t(initial ? 'Edit rule' : 'Your rule')}</h2>
          </div>
          <div className="mix-rule-header-actions">
            <button
              type="button"
              className="mix-rule-icon"
              aria-label={t('More')}
              aria-expanded={menu}
              onClick={() => setMenu((v) => !v)}
            >
              <Ellipsis size={20} />
            </button>
            <button
              type="button"
              className="mix-rule-icon"
              disabled={busy}
              aria-label={t('Close')}
              onClick={close}
            >
              <X size={20} />
            </button>
            {menu ? (
              <div className="mix-rule-action-menu">
                <button
                  type="button"
                  onClick={() => {
                    setMenu(false)
                    setCopyOpen(true)
                  }}
                >
                  <Copy size={14} />
                  {t('Copy a rule')}
                </button>
              </div>
            ) : null}
          </div>
        </header>
        <div className="mix-rule-body">
          <div
            className={`mix-rule-name${descriptionMode ? ' is-description' : ''}`}
          >
            <div className="mix-rule-name-heading">
              <label
                htmlFor={`${fieldId}-${descriptionMode ? 'description' : 'name'}`}
              >
                {t(descriptionMode ? 'Mix description' : 'Mix name')}
              </label>
              <button
                type="button"
                className="mix-rule-field-toggle"
                aria-label={t(
                  descriptionMode
                    ? 'Edit mix name'
                    : rule.description
                      ? 'Edit mix description'
                      : 'Add a description',
                )}
                onClick={() => setDescriptionMode((value) => !value)}
              >
                <ArrowRight size={14} />
              </button>
              <output
                id={`${fieldId}-count`}
                className={`mix-rule-description-count${(rule.description?.length ?? 0) >= 100 ? ' is-warning' : ''}`}
                aria-hidden={!descriptionMode}
              >
                {rule.description?.length ?? 0} / 150
              </output>
            </div>
            <div className="mix-rule-name-fields">
              <input
                id={`${fieldId}-name`}
                ref={nameInput}
                maxLength={100}
                value={rule.name}
                disabled={descriptionMode}
                aria-hidden={descriptionMode}
                onChange={(e) => change({ name: e.target.value })}
                placeholder={t('My mix')}
              />
              <textarea
                id={`${fieldId}-description`}
                ref={descriptionInput}
                maxLength={150}
                value={rule.description ?? ''}
                disabled={!descriptionMode}
                aria-hidden={!descriptionMode}
                aria-describedby={`${fieldId}-count`}
                onChange={(e) => change({ description: e.target.value })}
                placeholder={t('What would you like to hear?')}
              />
            </div>
          </div>
          <div className="mix-rule-grid">
            {field(
              'Track count',
              <ListMusic size={15} />,
              <SingleRange
                label={t('Track count')}
                value={rule.trackCount ?? 24}
                min={1}
                max={50}
                step={1}
                onChange={(trackCount) => change({ trackCount })}
                format={(value) => String(value)}
              />,
            )}
            {field(
              'Rebuild interval',
              <TimerReset size={15} />,
              <SingleRange
                label={t('Rebuild interval')}
                value={rule.refreshIntervalMinutes ?? 0}
                min={0}
                max={1440}
                step={10}
                onChange={(refreshIntervalMinutes) =>
                  change({ refreshIntervalMinutes })
                }
                format={(value) =>
                  value === 0
                    ? t('Every time opened')
                    : `${Math.floor(value / 60) ? `${Math.floor(value / 60)} ${t('hours short')}` : ''}${value >= 60 && value % 60 ? ' ' : ''}${value % 60 ? `${value % 60} ${t('minutes short')}` : ''}`
                }
              />,
            )}
            {field(
              'Artists',
              <Users size={15} />,
              <>
                <MultiSelect
                  label={t('Artists')}
                  options={artists.map((a) => ({
                    id: String(a.id),
                    name: a.name,
                    avatar: a.imagePath,
                    artist: true,
                  }))}
                  values={rule.artistIds.map(String)}
                  onChange={(ids) => change({ artistIds: ids.map(Number) })}
                  mode={
                    <Mode
                      value={rule.artistMode}
                      onChange={(artistMode) => change({ artistMode })}
                    />
                  }
                />
                {artistError ? (
                  <small className="error-line">
                    {t('Could not load artists')}
                  </small>
                ) : null}
              </>,
            )}
            {field(
              'Listening time',
              <Clock3 size={15} />,
              <Range
                label={t('Listening time')}
                value={rule.timeWindow}
                max={1440}
                step={30}
                format={time}
                disabled={rule.specials.includes('currentHour')}
                onChange={(timeWindow) => change({ timeWindow })}
              />,
            )}
            {field(
              'Average completion',
              <History size={15} />,
              <Range
                label={t('Average completion')}
                value={rule.completionPercent}
                onChange={(completionPercent) => change({ completionPercent })}
              />,
            )}
            {field(
              'Genres',
              <Music2 size={15} />,
              <MultiSelect
                label={t('Genres')}
                options={genreOptions}
                values={rule.genres}
                onChange={(genres) => change({ genres })}
                mode={
                  <Mode
                    value={rule.genreMode}
                    onChange={(genreMode) => change({ genreMode })}
                  />
                }
              />,
            )}
            {field(
              'Share of selected genres',
              <Music2 size={15} />,
              <Range
                label={t('Share of selected genres')}
                value={rule.genrePercent}
                disabled={!rule.genres.length || rule.genreMode === 'deny'}
                onChange={(genrePercent) => change({ genrePercent })}
              />,
            )}
            {field(
              'Track sources',
              <Folder size={15} />,
              <MultiSelect
                label={t('Track sources')}
                options={[
                  {
                    id: 'local',
                    name: t('Local files'),
                    icon: <Folder size={15} color="white" />,
                  },
                  {
                    id: 'soundcloud',
                    name: 'SoundCloud',
                    icon: (
                      <BrandIcon
                        mark="soundcloud"
                        size={17}
                        style={{ fill: '#ff5500' }}
                      />
                    ),
                  },
                  {
                    id: 'youtube',
                    name: 'YouTube Music',
                    icon: (
                      <BrandIcon
                        mark="youtubemusic"
                        size={17}
                        style={{ fill: '#ff0033' }}
                      />
                    ),
                  },
                ]}
                values={rule.sources}
                onChange={(sources) =>
                  change({ sources: sources as CustomMixRule['sources'] })
                }
              />,
            )}
            {field(
              'Special rules',
              <Sparkles size={15} />,
              <MultiSelect
                label={t('Special rules')}
                options={[
                  {
                    id: 'currentHour',
                    name: t('For this hour'),
                    icon: <Clock3 size={14} />,
                  },
                  {
                    id: 'onlineGenre',
                    name: t('SoundCloud genre discovery'),
                    icon: (
                      <BrandIcon
                        mark="soundcloud"
                        size={16}
                        style={{ fill: '#ff5500' }}
                      />
                    ),
                  },
                  {
                    id: 'forgotten',
                    name: t('Forgotten tracks'),
                    icon: <History size={14} />,
                  },
                  {
                    id: 'onRepeat',
                    name: t('On repeat'),
                    icon: <History size={14} />,
                  },
                  {
                    id: 'newToYou',
                    name: t('New to you'),
                    icon: <Sparkles size={14} />,
                  },
                  {
                    id: 'noSkips',
                    name: t('No skips'),
                    icon: <Check size={14} />,
                  },
                ]}
                values={rule.specials}
                onChange={(specials) =>
                  change({ specials: specials as CustomMixRule['specials'] })
                }
              />,
            )}
            {field(
              'Share of forgotten tracks',
              <History size={15} />,
              <Range
                label={t('Share of forgotten tracks')}
                value={rule.forgottenPercent}
                disabled={!rule.specials.includes('forgotten')}
                onChange={(forgottenPercent) => change({ forgottenPercent })}
              />,
            )}
            {field(
              'Days since last play',
              <History size={15} />,
              <Range
                label={t('Days since last play')}
                value={rule.forgottenDays}
                min={1}
                max={365}
                format={(n) => String(n)}
                disabled={!rule.specials.includes('forgotten')}
                onChange={(forgottenDays) => change({ forgottenDays })}
              />,
            )}
          </div>
        </div>
        <footer>
          {onDelete ? (
            <button
              type="button"
              className="mix-rule-delete"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await onDelete()
                  setClosing(true)
                  closeTimer.current = setTimeout(onClose, 170)
                } catch (e) {
                  setError(String(e))
                  setBusy(false)
                }
              }}
            >
              <Trash2 size={15} />
              {t('Delete')}
            </button>
          ) : (
            <span />
          )}
          <span className="mix-rule-error" role="status">
            {error}
          </span>
          <button type="button" className="btn" disabled={busy} onClick={close}>
            {t('Cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !rule.name.trim() || !rule.sources.length}
            onClick={() => void submit()}
          >
            {t(busy ? 'Saving…' : 'Save rule')}
          </button>
        </footer>
        {copyOpen ? (
          <div
            className="mix-rule-copy-backdrop"
            onPointerDown={(e) => {
              if (e.target === e.currentTarget) setCopyOpen(false)
            }}
          >
            <div
              className="mix-rule-copy"
              ref={nested}
              role="dialog"
              aria-modal="true"
              aria-label={t('Copy a rule')}
            >
              <header>
                <button
                  type="button"
                  className="mix-rule-icon"
                  onClick={() => setCopyOpen(false)}
                  aria-label={t('Back')}
                >
                  <ArrowLeft size={18} />
                </button>
                <h3>{t('Copy a rule')}</h3>
              </header>
              <div className="mix-rule-presets">
                {presets.map((preset, index) => (
                  <button
                    type="button"
                    key={index}
                    onClick={() => {
                      setRule({
                        ...structuredClone(preset.rule),
                        id: initial?.id ?? null,
                        name: rule.name || preset.name,
                        description:
                          rule.description || preset.rule.description || '',
                      })
                      setCopyOpen(false)
                    }}
                  >
                    <Cover path={preset.cover} label={preset.name} size={44} />
                    <span>{preset.name}</span>
                    <Copy size={15} />
                  </button>
                ))}
                {!presets.length ? <p>{t('No mixes yet')}</p> : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
