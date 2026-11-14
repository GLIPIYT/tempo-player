import { Heart, ListMusic } from 'lucide-react'
import Cover, { type CoverFetchPriority } from './Cover'
import './collectionDesign.css'

export default function CollectionArtwork({ paths, label, likes = false, eager = false, preferOriginal = false, fetchPriority }: {
  paths: readonly (string | null | undefined)[]
  label: string
  likes?: boolean
  eager?: boolean
  preferOriginal?: boolean
  fetchPriority?: CoverFetchPriority
}) {
  const unique = [...new Set(paths.filter((path): path is string => Boolean(path)))].slice(0, 4)
  const showLikesFallback = likes && unique.length === 0
  return <span className={`collection-artwork${showLikesFallback ? ' is-likes' : ''}${unique.length > 1 ? ` is-mosaic has-${unique.length}` : ''}`}>
    {showLikesFallback ? <Heart size={56} strokeWidth={1.1} fill="currentColor" /> : unique.length ? unique.map((path, index) => <Cover key={path} path={path} label={label} size={300} loading={eager ? 'eager' : 'lazy'} fetchPriority={index === 0 ? fetchPriority : fetchPriority === 'high' ? 'low' : undefined} preferOriginal={preferOriginal} />) : <ListMusic size={46} strokeWidth={1.2} />}
  </span>
}
