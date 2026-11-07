import { memo, useCallback, useState } from 'react'
import { buildArtworkSources, firstAvailableArtwork, type ArtworkResolution } from './artworkFallback'

/** The spinning ring shown wherever something is still being fetched. */
export function Spinner({ size = 12 }: { size?: number }) {
  return <span className="spin" style={{ width: size, height: size }} aria-hidden="true" />
}

/**
 * Artwork for a remote music item.
 *
 * Remote URLs use a plain `img`; alternate URLs are tried before falling back
 * to the first letter, so one stale thumbnail does not hide the artwork.
 */
interface ScArtworkProps {
  url: string | null
  /** Additional image URLs used when the primary image is unavailable. */
  fallbackUrls?: string[]
  title: string
  /** Show the spinner regardless of whether the image has loaded. */
  pending?: boolean
  /** Use SoundCloud's small thumbnail for track rows, retaining the full image as a fallback. */
  compact?: boolean
  /** Request a resolution suited to the artwork's rendered size. */
  resolution?: ArtworkResolution
  /** Let offscreen artwork wait until it approaches the viewport. */
  loading?: 'eager' | 'lazy'
}

function ScArtwork({
  url,
  fallbackUrls,
  title,
  pending = false,
  compact = false,
  resolution = 'full',
  loading,
}: ScArtworkProps) {
  const sources = buildArtworkSources(url, fallbackUrls, compact, resolution)
  const sourcesKey = sources.join('\u0000')
  // A new candidate list must get a new loading state, even if the primary URL
  // stays the same. Resetting it in an effect can hide an already loaded image.
  return <ArtworkImage key={sourcesKey} sources={sources} title={title} pending={pending} loading={loading} />
}

export default memo(ScArtwork)

function ArtworkImage({ sources, title, pending, loading }: { sources: string[]; title: string; pending: boolean; loading?: 'eager' | 'lazy' }) {
  const [failedSources, setFailedSources] = useState<string[]>([])
  const [loadedSource, setLoadedSource] = useState<string | null>(null)
  const source = firstAvailableArtwork(sources, failedSources)
  const attachImage = useCallback((image: HTMLImageElement | null) => {
    if (source && image?.complete && image.naturalWidth > 0) {
      setLoadedSource((current) => current === source ? current : source)
    }
  }, [source])

  if (!source) {
    return <span className="sc-art sc-art-fallback">{(title.trim()[0] ?? '?').toUpperCase()}</span>
  }
  // The image is always mounted and always in the layout; the ring sits over
  // it. Hiding the image instead would make the ring depend on onLoad firing
  // for something that is not being displayed, which is a poor thing to rely
  // on for the only path that ever clears it.
  const waiting = pending || loadedSource !== source

  return (
    <span className="sc-art-box">
      <img
        className="sc-art"
        key={source}
        src={source}
        alt=""
        draggable={false}
        loading={loading}
        decoding="async"
        ref={attachImage}
        onLoad={() => setLoadedSource(source)}
        onError={() => setFailedSources((failed) => [...new Set([...failed, source])])}
      />
      {waiting ? (
        <span className="sc-art-veil">
          <Spinner size={14} />
        </span>
      ) : null}
    </span>
  )
}
