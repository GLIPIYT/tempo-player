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
    const hostAllowed = result.provider === 'commons'
      ? url.hostname === 'upload.wikimedia.org'
      : url.hostname === 'www.artic.edu'
    const pathAllowed = result.provider === 'commons'
      ? url.pathname.startsWith('/wikipedia/commons/')
      : url.pathname.startsWith('/iiif/2/')
    return url.protocol === 'https:' && hostAllowed && pathAllowed
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
      <form className="background-search-controls" onSubmit={(event) => void runSearch(event)}>
        <label className="background-search-field background-search-provider">
          <span className="background-search-label">{t('Source')}</span>
          <select
            value={provider}
            onChange={(event) => {
              setProvider(event.target.value as BackgroundImageProvider)
              clearSearch()
            }}
          >
            <option value="commons">Wikimedia Commons</option>
            <option value="artic">Art Institute of Chicago</option>
          </select>
        </label>

        <label className="background-search-field background-search-query">
          <span className="background-search-label">{t('Search')}</span>
          <span className="background-search-input-wrap">
            <Search size={14} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                clearSearch()
              }}
              placeholder={t('Search backgrounds')}
              maxLength={120}
            />
          </span>
        </label>

        <div className="background-search-field">
          <label className="background-search-label" htmlFor="background-search-resolution">
            {t('Minimum resolution')}
          </label>
          <select
            id="background-search-resolution"
            value={resolution}
            onChange={(event) => {
              setResolution(event.target.value as Resolution)
              clearSearch()
            }}
          >
            <option value="any">{t('Any resolution')}</option>
            <option value="hd">1280 × 720</option>
            <option value="full-hd">1920 × 1080</option>
            <option value="qhd">2560 × 1440</option>
          </select>
        </div>

        <div className="background-search-field">
          <label className="background-search-label" htmlFor="background-search-orientation">
            {t('Orientation')}
          </label>
          <select
            id="background-search-orientation"
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
        </div>

        <button className="btn btn-primary background-search-submit" type="submit" disabled={!query.trim() || loading}>
          {loading ? <Loader2 size={14} className="background-search-spinner" /> : <Search size={14} />}
          {t('Search images')}
        </button>
      </form>

      {error ? <div className="background-search-error" role="alert">{error}</div> : null}

      <div className="background-search-status" aria-live="polite">
        {loading ? (
          <span><Loader2 size={14} className="background-search-spinner" />{t('Searching…')}</span>
        ) : hasSearched && results.length === 0 && !error ? (
          <span>{t('No background images found')}</span>
        ) : !hasSearched ? (
          <span>{t('Search for a background')}</span>
        ) : null}
      </div>

      {results.length > 0 ? (
        <ul className="background-search-results">
          {results.map((result) => {
            const id = `${result.provider}:${result.id}`
            const isSelecting = selectingId === id
            return (
              <li className="background-search-result" key={id}>
                <div className="background-search-thumb">
                  <ImageIcon size={20} aria-hidden="true" />
                  <img
                    src={isProviderImageUrl(result) ? result.previewUrl : undefined}
                    alt=""
                    loading="lazy"
                    onError={(event) => { event.currentTarget.hidden = true }}
                  />
                </div>
                <div className="background-search-result-content">
                  <div className="background-search-result-title" title={result.title}>{result.title}</div>
                  {result.author ? (
                    <div className="background-search-result-author" title={result.author}>{result.author}</div>
                  ) : null}
                  <div className="background-search-result-meta">
                    {result.license ? (
                      result.licenseUrl && isSafeAttributionUrl(result.licenseUrl) ? (
                        <a
                          href={result.licenseUrl}
                          title={result.license}
                          onClick={(event) => {
                            event.preventDefault()
                            void openAttribution(result.licenseUrl!)
                          }}
                        >
                          {result.license}
                        </a>
                      ) : (
                        <span title={result.license}>{result.license}</span>
                      )
                    ) : null}
                    {isSafeAttributionUrl(result.sourceUrl) ? (
                      <a
                        href={result.sourceUrl}
                        aria-label={`${t('Open source page')}: ${PROVIDER_NAMES[result.provider]}`}
                        title={t('Open source page')}
                        onClick={(event) => {
                          event.preventDefault()
                          void openAttribution(result.sourceUrl)
                        }}
                      >
                        {PROVIDER_NAMES[result.provider]} <ArrowUpRight size={11} aria-hidden="true" />
                      </a>
                    ) : <span>{PROVIDER_NAMES[result.provider]}</span>}
                  </div>
                  <button
                    className="btn background-search-use"
                    type="button"
                    disabled={selectingId !== null}
                    onClick={() => void chooseImage(result)}
                  >
                    {isSelecting ? <Loader2 size={12} className="background-search-spinner" /> : null}
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
