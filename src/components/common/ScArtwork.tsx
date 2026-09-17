import { useEffect, useState } from 'react'

/** The spinning ring shown wherever something is still being fetched. */
export function Spinner({ size = 12 }: { size?: number }) {
  return <span className="spin" style={{ width: size, height: size }} aria-hidden="true" />
}

/**
 * Artwork for a SoundCloud item.
 *
 * Remote URLs are rendered directly rather than through the asset protocol -
 * `Cover` assumes a local path and would run these through `convertFileSrc`.
 * SoundCloud's CDN sends no referrer restrictions, so a plain `img` works, and
 * a broken URL falls back to the first letter the same way a missing cover does.
 */
export default function ScArtwork({
  url,
  title,
  pending = false,
}: {
  url: string | null
  title: string
  /** Show the spinner regardless of whether the image has loaded. */
  pending?: boolean
}) {
  const [broken, setBroken] = useState(false)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    setBroken(false)
    setLoaded(false)
  }, [url])
  if (!url || broken) {
    return <span className="sc-art sc-art-fallback">{(title.trim()[0] ?? '?').toUpperCase()}</span>
  }
  const waiting = pending || !loaded
  return (
    <>
      {waiting ? (
        <span className="sc-art sc-art-loading">
          <Spinner size={14} />
        </span>
      ) : null}
      {/* Kept mounted while it loads, so onLoad can fire - hidden rather than
          absent, because a display:none image still fetches. */}
      <img
        className="sc-art"
        style={waiting ? { display: 'none' } : undefined}
        src={url}
        alt=""
        draggable={false}
        onLoad={() => setLoaded(true)}
        onError={() => setBroken(true)}
      />
    </>
  )
}
