import { useEffect, useState } from 'react'
import { firstAvailableArtwork } from './artworkFallback'

/** The spinning ring shown wherever something is still being fetched. */
export function Spinner({ size = 12 }: { size?: number }) {
  return <span className="spin" style={{ width: size, height: size }} aria-hidden="true" />
}

/**
 * Artwork for a remote music item.
 *
 * Remote URLs are rendered directly rather than through the asset protocol -
 * `Cover` assumes a local path and would run these through `convertFileSrc`.
 * Remote URLs use a plain `img`; alternate URLs are tried before falling back
 * to the first letter, so one stale thumbnail does not hide the artwork.
 */
export default function ScArtwork({
  url,
  fallbackUrls = [],
  title,
  pending = false,
}: {
  url: string | null
  /** Additional image URLs used when the primary image is unavailable. */
  fallbackUrls?: string[]
  title: string
  /** Show the spinner regardless of whether the image has loaded. */
  pending?: boolean
}) {
  const sources = Array.from(new Set([url, ...fallbackUrls].filter((source): source is string => Boolean(source))))
  const sourcesKey = sources.join('\u0000')
  const [failedSources, setFailedSources] = useState<string[]>([])
  const [loadedSource, setLoadedSource] = useState<string | null>(null)
  const source = firstAvailableArtwork(sources, failedSources)

  useEffect(() => {
    setFailedSources([])
    setLoadedSource(null)
  }, [sourcesKey])
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
