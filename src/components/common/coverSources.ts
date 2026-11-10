/** Build image candidates for a cover without changing its normal card size. */
export function buildCoverSources(path: string | null | undefined, preferOriginal = false): string[] {
  if (!path) return []

  const original = preferOriginal ? originalYoutubeArtworkUrl(path) : null
  return original && original !== path ? [original, path] : [path]
}

/**
 * YouTube Music's Google image URLs commonly point at a 544px rendition even
 * when the same image has a larger original. `=s0` asks the image host for
 * that original; keep the reported rendition as a fallback if it is absent.
 */
function originalYoutubeArtworkUrl(path: string): string | null {
  let url: URL
  try {
    url = new URL(path)
  } catch {
    return null
  }

  if (url.protocol !== 'https:' || !/^lh\d\.googleusercontent\.com$/i.test(url.hostname)) return null

  const modifierStart = url.pathname.lastIndexOf('=')
  if (modifierStart < 0) return null

  const modifier = url.pathname.slice(modifierStart)
  if (!/^=(?:w\d+-h\d+|s\d+)(?:-[a-z\d]+)*$/i.test(modifier)) return null

  url.pathname = `${url.pathname.slice(0, modifierStart)}=s0`
  return url.toString()
}
