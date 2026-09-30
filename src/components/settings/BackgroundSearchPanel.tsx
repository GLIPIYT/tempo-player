import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, Image as ImageIcon, Loader2, Search, SlidersHorizontal } from 'lucide-react'
import { api } from '../../api/client'
import { useT } from '../../i18n'
import type {
  BackgroundImageCategory,
  BackgroundImageOrientation,
  BackgroundImageProvider,
  BackgroundImageResult,
  BackgroundProviderStatus,
  BackgroundSearchFilters,
  BackgroundSearchPage,
} from '../../types/backgrounds'
import './BackgroundSearchPanel.css'

interface Props {
  search: (
    provider: BackgroundImageProvider,
    query: string,
    filters: BackgroundSearchFilters,
  ) => Promise<BackgroundSearchPage>
  onSelect: (result: BackgroundImageResult) => void | Promise<void>
}

type Resolution = 'any' | 'hd' | 'full-hd' | 'qhd'
const PAGE_SIZE = 24
const RESOLUTIONS: Record<Resolution, Pick<BackgroundSearchFilters, 'minWidth' | 'minHeight'>> = {
  any: { minWidth: 0, minHeight: 0 },
  hd: { minWidth: 1280, minHeight: 720 },
  'full-hd': { minWidth: 1920, minHeight: 1080 },
  qhd: { minWidth: 2560, minHeight: 1440 },
}
const PROVIDER_NAMES: Record<BackgroundImageProvider, string> = {
  wallhaven: 'Wallhaven',
  pinterest: 'Pinterest',
  konachan: 'Konachan',
}
const DEFAULT_STATUSES: BackgroundProviderStatus[] = [
  { id: 'wallhaven', available: true, supportsCategories: true, supportsColor: true, supportsNsfw: false, notice: null },
  { id: 'pinterest', available: false, supportsCategories: false, supportsColor: false, supportsNsfw: false, notice: null },
  { id: 'konachan', available: true, supportsCategories: false, supportsColor: false, supportsNsfw: true, notice: null },
]
const COLORS = [
  '660000', '990000', 'cc0000', 'cc3333', 'ea4c88', '993399', '663399', '333399',
  '0066cc', '0099cc', '66cccc', '77cc33', '669900', '336600', '666600', '999900',
  'cccc33', 'ffff00', 'ffcc33', 'ff9900', 'ff6600', 'cc6633', '996633', '663300',
  '000000', '999999', 'cccccc', 'ffffff', '424153',
]
const CATEGORIES: { id: Exclude<BackgroundImageCategory, 'all'>; label: string }[] = [
  { id: 'anime', label: 'Anime' },
  { id: 'general', label: 'General' },
  { id: 'people', label: 'People' },
]

function displayError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

function isProviderImageUrl(result: Pick<BackgroundImageResult, 'provider' | 'previewUrl'>): boolean {
  try {
    const url = new URL(result.previewUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
    if (result.provider === 'wallhaven') return ['th.wallhaven.cc', 'w.wallhaven.cc'].includes(url.hostname)
    if (result.provider === 'pinterest') return url.hostname === 'i.pinimg.com'
    return ['konachan.net', 'konachan.com'].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
  } catch {
    return false
  }
}

function WallpaperPreview({ result }: { result: BackgroundImageResult }) {
  const { provider, previewUrl } = result
  const t = useT()
  const [source, setSource] = useState<string | null>(() => isProviderImageUrl(result) ? result.previewUrl : null)
  const [failed, setFailed] = useState(false)
  const [proxyLoading, setProxyLoading] = useState(false)
  const proxyAttempted = useRef(false)
  const generation = useRef(0)

  useEffect(() => {
    generation.current += 1
    proxyAttempted.current = false
    setSource(isProviderImageUrl({ provider, previewUrl }) ? previewUrl : null)
    setFailed(false)
    setProxyLoading(false)
    return () => { generation.current += 1 }
  }, [provider, previewUrl])

  const retryWithProxy = async () => {
    if (proxyAttempted.current || !isProviderImageUrl(result)) {
      setSource(null)
      setFailed(true)
      return
    }
    proxyAttempted.current = true
    const currentGeneration = generation.current
    setSource(null)
    setProxyLoading(true)
    try {
      const proxied = await api.getBackgroundPreview(result.provider, result.previewUrl)
      if (currentGeneration !== generation.current) return
      if (!/^data:image\/(?:png|jpeg|webp|gif|avif);base64,/.test(proxied)) throw new Error('Invalid image')
      setSource(proxied)
    } catch {
      if (currentGeneration === generation.current) setFailed(true)
    } finally {
      if (currentGeneration === generation.current) setProxyLoading(false)
    }
  }

  return <>
    {proxyLoading
      ? <Loader2 className="background-search-placeholder background-search-spinner" size={22} aria-hidden="true" />
      : <ImageIcon className="background-search-placeholder" size={24} aria-hidden="true" />}
    {source ? <img src={source} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => void retryWithProxy()} /> : null}
    {failed ? <span className="background-search-preview-error">{t('Image preview unavailable')}</span> : null}
  </>
}

export default function BackgroundSearchPanel({ search, onSelect }: Props) {
  const t = useT()
  const [provider, setProvider] = useState<BackgroundImageProvider>('wallhaven')
  const [query, setQuery] = useState('')
  const [term, setTerm] = useState('')
  const [resolution, setResolution] = useState<Resolution>('hd')
  const [orientation, setOrientation] = useState<BackgroundImageOrientation>('landscape')
  const [category, setCategory] = useState<BackgroundImageCategory>('anime')
  const [color, setColor] = useState<string | null>(null)
  const [includeNsfw, setIncludeNsfw] = useState(false)
  const [statuses, setStatuses] = useState(DEFAULT_STATUSES)
  const [statusesReady, setStatusesReady] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [results, setResults] = useState<BackgroundImageResult[]>([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectingId, setSelectingId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchRevision, setSearchRevision] = useState(0)
  const requestId = useRef(0)
  const loadingMoreRef = useRef(false)
  const filtersRef = useRef<HTMLDivElement>(null)
  const status = statuses.find((item) => item.id === provider) ?? DEFAULT_STATUSES[0]
  const searchFailureLabel = t('Background image search failed')

  useEffect(() => {
    let active = true
    api.getBackgroundProviderStatus().then((found) => {
      if (active) setStatuses(found)
    }).catch(() => {}).finally(() => {
      if (active) setStatusesReady(true)
    })
    return () => { active = false; requestId.current += 1 }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(query.trim()), 500)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (!filterOpen) return
    const closeOnOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !filtersRef.current?.contains(event.target)) setFilterOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFilterOpen(false)
        filtersRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
      }
    }
    document.addEventListener('pointerdown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [filterOpen])

  const runSearch = useCallback(async (requestedPage = 1) => {
    if (!statusesReady || !status.available || provider === 'pinterest' && !term) return
    const append = requestedPage > 1
    if (append) {
      if (loadingMoreRef.current) return
      loadingMoreRef.current = true
      setLoadingMore(true)
    } else {
      loadingMoreRef.current = false
      setLoading(true)
      setResults([])
      setHasSearched(true)
    }
    const currentRequest = ++requestId.current
    setError(null)
    try {
      const found = await search(provider, term, {
        ...RESOLUTIONS[resolution], orientation, limit: PAGE_SIZE,
        category: status.supportsCategories ? category : 'all',
        color: status.supportsColor ? color : null,
        includeNsfw: status.supportsNsfw && includeNsfw,
        page: requestedPage,
      })
      if (currentRequest !== requestId.current) return
      setResults((previous) => {
        if (!append) return found.images
        const knownIds = new Set(previous.map((item) => `${item.provider}:${item.id}`))
        return [...previous, ...found.images.filter((item) => !knownIds.has(`${item.provider}:${item.id}`))]
      })
      setPage(found.page)
      setHasMore(found.hasMore)
    } catch (cause) {
      if (currentRequest === requestId.current) setError(displayError(cause, searchFailureLabel))
    } finally {
      if (currentRequest === requestId.current) {
        setLoading(false)
        setLoadingMore(false)
        if (append) loadingMoreRef.current = false
      }
    }
  }, [search, statusesReady, status.available, status.supportsCategories, status.supportsColor, status.supportsNsfw,
    provider, term, resolution, orientation, category, color, includeNsfw, searchFailureLabel])

  useEffect(() => {
    requestId.current += 1
    loadingMoreRef.current = false
    setError(null)
    setResults([])
    setHasMore(false)
    setLoadingMore(false)
    setLoading(statusesReady && status.available)
    if (!status.available) { setHasSearched(false); return }
    if (provider === 'pinterest' && !term) { setLoading(false); setHasSearched(false); return }
    const timer = window.setTimeout(() => void runSearch(), 180)
    return () => { window.clearTimeout(timer); requestId.current += 1 }
  }, [runSearch, searchRevision, statusesReady, status.available, provider, term])

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setTerm(query.trim())
    setSearchRevision((previous) => previous + 1)
  }

  const chooseImage = async (result: BackgroundImageResult) => {
    const id = `${result.provider}:${result.id}`
    setSelectingId(id)
    setError(null)
    try {
      await onSelect(result)
      setSelectedId(id)
    } catch (cause) {
      setError(displayError(cause, t('Could not use this image')))
    } finally {
      setSelectingId(null)
    }
  }

  return (
    <section className="background-search-panel" aria-label={t('Search for background images')}>
      <div className="background-search-providers" role="group" aria-label={t('Source')}>
        {(Object.keys(PROVIDER_NAMES) as BackgroundImageProvider[]).map((source) => (
          <button key={source} className="background-search-provider-tab" type="button" aria-pressed={provider === source}
            onClick={() => { setProvider(source); setIncludeNsfw(false); setFilterOpen(false) }}>
            {PROVIDER_NAMES[source]}
          </button>
        ))}
      </div>

      <div className="background-search-toolbar">
        <form className="background-search-query" onSubmit={submitSearch}>
          <button type="submit" className="background-search-submit" aria-label={t('Search images')} disabled={!status.available}>
            <Search size={16} aria-hidden="true" />
          </button>
          <label className="sr-only" htmlFor="background-search-query">{t('Search')}</label>
          <input id="background-search-query" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder={t('Search wallpapers, tags…')} maxLength={120} disabled={!status.available} />
        </form>
        {status.supportsCategories ? <div className="background-search-categories" role="group" aria-label={t('Category')}>
          {CATEGORIES.map((item) => <button key={item.id} type="button" aria-pressed={category === item.id}
            onClick={() => setCategory(category === item.id ? 'all' : item.id)}>{t(item.label)}</button>)}
        </div> : null}
        <div className="background-search-filter-wrap" ref={filtersRef}>
          <button className="background-search-filter-toggle" type="button" title={t('Filters')} aria-label={t('Filters')}
            aria-expanded={filterOpen} aria-controls="background-search-extra-filters" disabled={!status.available}
            onClick={() => setFilterOpen(!filterOpen)}>
            <SlidersHorizontal size={16} aria-hidden="true" />
          </button>
          {filterOpen ? <div className="background-search-filter-popover" id="background-search-extra-filters">
            <label><span>{t('Minimum resolution')}</span>
              <select value={resolution} onChange={(event) => setResolution(event.target.value as Resolution)}>
                <option value="any">{t('Any resolution')}</option><option value="hd">1280 × 720+</option>
                <option value="full-hd">1920 × 1080+</option><option value="qhd">2560 × 1440+</option>
              </select>
            </label>
            <label><span>{t('Orientation')}</span>
              <select value={orientation} onChange={(event) => setOrientation(event.target.value as BackgroundImageOrientation)}>
                <option value="landscape">{t('Landscape')}</option><option value="portrait">{t('Portrait')}</option>
                <option value="square">{t('Square')}</option><option value="any">{t('Any orientation')}</option>
              </select>
            </label>
          </div> : null}
        </div>
      </div>

      {status.supportsColor ? <div className="background-search-colors" role="group" aria-label={t('Color')}>
        <span className="background-search-control-label">{t('Color')}</span>
        <button type="button" className="background-search-any-color" aria-pressed={color === null} onClick={() => setColor(null)}>{t('Any color')}</button>
        {COLORS.map((value) => <button key={value} type="button" className="background-search-color" style={{ backgroundColor: `#${value}` }}
          aria-label={`#${value}`} title={`#${value}`} aria-pressed={color === value} onClick={() => setColor(color === value ? null : value)}>
          {color === value ? <Check size={13} aria-hidden="true" /> : null}
        </button>)}
      </div> : null}

      {status.supportsNsfw ? <div className="background-search-content-filter">
        <button className="background-search-adult-toggle" type="button" aria-pressed={includeNsfw}
          aria-label={includeNsfw ? t('Show safe images only') : t('Show adult images')}
          onClick={() => setIncludeNsfw(!includeNsfw)}>18+</button>
        <span>{includeNsfw ? t('NSFW images only') : t('Safe images only')}</span>
      </div> : null}

      {error ? <div className="background-search-error" role="alert">{t(error)}</div> : null}
      {!status.available && statusesReady ? <div className="background-search-empty" role="status">
        {status.notice ? t(status.notice) : t('Background provider unavailable')}
      </div> : null}
      {status.available && provider === 'pinterest' && !term ? <div className="background-search-empty" role="status">
        {t('Search for a background')}
      </div> : null}
      {loading || hasSearched && results.length === 0 && !error ? <div className="background-search-status" aria-live="polite">
        {loading ? <span><Loader2 size={14} className="background-search-spinner" aria-hidden="true" />{t('Searching…')}</span>
          : <span>{t('No background images found')}</span>}
      </div> : null}

      {results.length > 0 ? <ul className="background-search-results" aria-label={t('Search for background images')}
        onScroll={(event) => {
          const list = event.currentTarget
          const nearEnd = list.scrollHeight - list.scrollTop - list.clientHeight <= 160
          if (nearEnd && list.scrollHeight > list.clientHeight && hasMore && !loading && !loadingMoreRef.current) {
            void runSearch(page + 1)
          }
        }}>
        {results.map((result) => {
          const id = `${result.provider}:${result.id}`
          const isSelecting = selectingId === id
          const isSelected = selectedId === id
          return <li className={`background-search-result${isSelected ? ' is-selected' : ''}`} key={id}>
            <div className="background-search-thumb">
              <WallpaperPreview result={result} />
              {result.width > 0 && result.height > 0 ? <span className="background-search-dimensions">{result.width}×{result.height}</span> : null}
              <button className={`background-search-use${isSelecting ? ' is-saving' : ''}`} type="button" disabled={selectingId !== null}
                aria-label={`${t('Set background')}: ${result.title || result.id}`} onClick={() => void chooseImage(result)}>
                {isSelecting ? <Loader2 size={13} className="background-search-spinner" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                {isSelecting ? t('Saving image…') : t('Set background')}
              </button>
            </div>
          </li>
        })}
      </ul> : null}
      {hasMore ? <button className="background-search-more" type="button" disabled={loading || loadingMore}
        onClick={() => void runSearch(page + 1)}>
        {loadingMore ? <Loader2 size={14} className="background-search-spinner" aria-hidden="true" /> : null}{t('Load more')}
      </button> : null}
    </section>
  )
}
