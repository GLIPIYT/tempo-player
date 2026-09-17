import { useEffect, useState } from 'react'

/**
 * Artwork for a SoundCloud item.
 *
 * Remote URLs are rendered directly rather than through the asset protocol -
 * `Cover` assumes a local path and would run these through `convertFileSrc`.
 * SoundCloud's CDN sends no referrer restrictions, so a plain `img` works, and
 * a broken URL falls back to the first letter the same way a missing cover does.
 */
export default function ScArtwork({ url, title }: { url: string | null; title: string }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    setBroken(false)
  }, [url])
  if (!url || broken) {
    return <span className="sc-art sc-art-fallback">{(title.trim()[0] ?? '?').toUpperCase()}</span>
  }
  return <img className="sc-art" src={url} alt="" draggable={false} onError={() => setBroken(true)} />
}
