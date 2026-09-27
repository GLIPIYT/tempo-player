import { useRef, useState, type FormEvent } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { ArrowUpRight, Image as ImageIcon, Loader2, Search } from 'lucide-react'
import { useT } from '../../i18n'
import type {
  BackgroundImageOrientation,
  BackgroundImageProvider,
  BackgroundImageResult,
  BackgroundSearchFilters,
} from '../../types/backgrounds'
import './BackgroundSearchPanel.css'

interface Props {
  search: (
    provider: BackgroundImageProvider,
    query: string,
    filters: BackgroundSearchFilters,
  ) => Promise<BackgroundImageResult[]>
  onSelect: (result: BackgroundImageResult) => void | Promise<void>
}

type Resolution = 'any' | 'hd' | 'full-hd' | 'qhd'

const RESOLUTIONS: Record<Resolution, Pick<BackgroundSearchFilters, 'minWidth' | 'minHeight'>> = {
  any: { minWidth: 0, minHeight: 0 },
  hd: { minWidth: 1280, minHeight: 720 },
  'full-hd': { minWidth: 1920, minHeight: 1080 },
  qhd: { minWidth: 2560, minHeight: 1440 },
}

const PROVIDER_NAMES: Record<BackgroundImageProvider, string> = {
  commons: 'Wikimedia Commons',
  artic: 'Art Institute of Chicago',
}

function displayError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

function isSafeAttributionUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
    if (url.hostname === 'commons.wikimedia.org') {
      return url.pathname === '/' || url.pathname.startsWith('/wiki/')
    }
    if (url.hostname === 'www.artic.edu') {
      return url.pathname.startsWith('/artworks/') || url.pathname === '/open-access/open-access-images'
    }
    if (url.hostname === 'creativecommons.org') {
      return url.pathname.startsWith('/licenses/') || url.pathname.startsWith('/publicdomain/')
    }
    return false
  } catch {
    return false
  }
}

function isProviderImageUrl(result: BackgroundImageResult): boolean {
  try {
    const url = new URL(result.previewUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
    if (result.provider === 'commons') {
      // Commons now serves generated thumbnails from thumb.wikimedia.org;
      // older results may still use upload.wikimedia.org.
      return (url.hostname === 'thumb.wikimedia.org'
        && url.pathname.startsWith('/wikipedia/commons/thumb/')
        || url.hostname === 'upload.wikimedia.org'
        && url.pathname.startsWith('/wikipedia/commons/'))
    }
    return url.hostname === 'www.artic.edu' && url.pathname.startsWith('/iiif/2/')
  } catch {
    return false
  }
}

export default function BackgroundSearchPanel({ search, onSelect }: Props) {
  const t = useT()
  const [provider, setProvider] = useState<BackgroundImageProvider>('commons')
  const [query, setQuery] = useState('')
  const [resolution, setResolution] = useState<Resolution>('hd')
  const [orientation, setOrientation] = useState<BackgroundImageOrientation>('landscape')
  const [results, setResults] = useState<BackgroundImageResult[]>([])
  const [hasSearched, setHasSearched] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectingId, setSelectingId] = useState<string | null>(null)
  const requestId = useRef(0)

  const clearSearch = () => {
    requestId.current += 1
    setResults([])
    setHasSearched(false)
    setLoading(false)
    setError(null)
  }

  const runSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const term = query.trim()
    if (!term) return

    const currentRequest = ++requestId.current
    setLoading(true)
    setError(null)
    setResults([])
    setHasSearched(true)

    try {
      const found = await search(provider, term, {
        ...RESOLUTIONS[resolution],
        orientation,
        limit: 30,
      })
      if (currentRequest === requestId.current) setResults(found)
    } catch (cause) {
      if (currentRequest === requestId.current) {
        setError(displayError(cause, t('Background image search failed')))
      }
    } finally {
      if (currentRequest === requestId.current) setLoading(false)
    }
  }

  const chooseImage = async (result: BackgroundImageResult) => {
    const id = `${result.provider}:${result.id}`
    setSelectingId(id)
    setError(null)
    try {
      await onSelect(result)
    } catch (cause) {
      setError(displayError(cause, t('Could not use this image')))
    } finally {
      setSelectingId(null)
    }
  }

  const openAttribution = async (url: string) => {
    if (!isSafeAttributionUrl(url)) return
    try {
      await openUrl(url)
    } catch (cause) {
      setError(displayError(cause, t('Could not open source page')))
    }
  }

  return (
    <section className="background-search-panel" aria-label={t('Search for background images')}>
      <div className="background-search-providers" role="group" aria-label={t('Source')}>
        {(Object.keys(PROVIDER_NAMES) as BackgroundImageProvider[]).map((source) => (
          <button
            key={source}
            className="background-search-provider-tab"
            type="button"
            aria-pressed={provider === source}
            onClick={() => {
              if (provider === source) return
              setProvider(source)
              clearSearch()
            }}
          >
            {PROVIDER_NAMES[source]}
          </button>
        ))}
      </div>

      <form className="background-search-controls" onSubmit={(event) => void runSearch(event)}>
        <label className="background-search-query">
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">{t('Search')}</span>
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              clearSearch()
            }}
            placeholder={t('Search backgrounds')}
            maxLength={120}
          />
        </label>

        <label className="background-search-filter">
          <span className="sr-only">{t('Minimum resolution')}</span>
          <select
            value={resolution}
            onChange={(event) => {
              setResolution(event.target.value as Resolution)
              clearSearch()
            }}
          >
            <option value="any">{t('Any resolution')}</option>
            <option value="hd">1280 × 720+</option>
            <option value="full-hd">1920 × 1080+</option>
            <option value="qhd">2560 × 1440+</option>
          </select>
        </label>

        <label className="background-search-filter">
          <span className="sr-only">{t('Orientation')}</span>
          <select
            value={orientation}
            onChange={(event) => {
              setOrientation(event.target.value as BackgroundImageOrientation)
              clearSearch()
            }}
          >
            <option value="landscape">{t('Landscape')}</option>
            <option value="portrait">{t('Portrait')}</option>
            <option value="square">{t('Square')}</option>
            <option value="any">{t('Any orientation')}</option>
          </select>
        </label>

        <button
          className="background-search-submit"
          type="submit"
          aria-label={t('Search images')}
          title={t('Search images')}
          disabled={!query.trim() || loading}
        >
          {loading
            ? <Loader2 size={16} className="background-search-spinner" aria-hidden="true" />
            : <Search size={16} aria-hidden="true" />}
        </button>
      </form>

      {error ? <div className="background-search-error" role="alert">{error}</div> : null}

      {loading || hasSearched && results.length === 0 && !error ? (
        <div className="background-search-status" aria-live="polite">
          {loading ? (
            <span><Loader2 size={13} className="background-search-spinner" aria-hidden="true" />{t('Searching…')}</span>
          ) : (
            <span>{t('No background images found')}</span>
          )}
        </div>
      ) : null}

      {results.length > 0 ? (
        <ul className="background-search-results">
          {results.map((result) => {
            const id = `${result.provider}:${result.id}`
            const isSelecting = selectingId === id
            const safePreviewUrl = isProviderImageUrl(result) ? result.previewUrl : undefined
            const safeSourceUrl = isSafeAttributionUrl(result.sourceUrl)
              ? result.sourceUrl
              : null
            const safeLicenseUrl = result.licenseUrl && isSafeAttributionUrl(result.licenseUrl)
              ? result.licenseUrl
              : null

            return (
              <li className="background-search-result" key={id}>
                <div className="background-search-thumb">
                  <ImageIcon className="background-search-placeholder" size={24} aria-hidden="true" />
                  {safePreviewUrl ? (
                    <img
                      src={safePreviewUrl}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      onError={(event) => { event.currentTarget.hidden = true }}
                    />
                  ) : null}

                  <div className="background-search-caption">
                    <div className="background-search-result-title" title={result.title}>{result.title}</div>
                    <div className="background-search-credit">
                      {result.author ? (
                        <span title={result.author}>{result.author}</span>
                      ) : null}
                      {result.license ? (
                        safeLicenseUrl ? (
                          <a
                            href={safeLicenseUrl}
                            title={result.license}
                            onClick={(event) => {
                              event.preventDefault()
                              void openAttribution(safeLicenseUrl)
                            }}
                          >
                            {result.license}
                          </a>
                        ) : (
                          <span title={result.license}>{result.license}</span>
                        )
                      ) : null}
                      {safeSourceUrl ? (
                        <a
                          href={safeSourceUrl}
                          aria-label={`${t('Open source page')}: ${PROVIDER_NAMES[result.provider]}`}
                          title={t('Open source page')}
                          onClick={(event) => {
                            event.preventDefault()
                            void openAttribution(safeSourceUrl)
                          }}
                        >
                          <ArrowUpRight size={13} aria-hidden="true" />
                        </a>
                      ) : null}
                    </div>
                  </div>

                  <span className="background-search-dimensions" title={`${result.width} × ${result.height}`}>
                    {result.width} × {result.height}
                  </span>

                  <button
                    className="background-search-use"
                    type="button"
                    disabled={selectingId !== null}
                    aria-label={`${t('Use image')}: ${result.title}`}
                    title={result.title}
                    onClick={() => void chooseImage(result)}
                  >
                    {isSelecting ? (
                      <Loader2 size={13} className="background-search-spinner" aria-hidden="true" />
                    ) : null}
                    {isSelecting ? t('Saving image…') : t('Use image')}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
