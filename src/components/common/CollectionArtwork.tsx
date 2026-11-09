import { Heart, ListMusic } from 'lucide-react'
import Cover from './Cover'
import './collectionDesign.css'

export default function CollectionArtwork({ paths, label, likes = false, eager = false }: {
  paths: readonly (string | null | undefined)[]
  label: string
  likes?: boolean
  eager?: boolean
}) {
  const unique = [...new Set(paths.filter((path): path is string => Boolean(path)))].slice(0, 4)
  return <span className={`collection-artwork${likes ? ' is-likes' : ''}${unique.length > 1 && !likes ? ` is-mosaic has-${unique.length}` : ''}`}>
    {likes ? <Heart size={56} strokeWidth={1.1} fill="currentColor" /> : unique.length ? unique.map(path => <Cover key={path} path={path} label={label} size={300} loading={eager ? 'eager' : 'lazy'} />) : <ListMusic size={46} strokeWidth={1.2} />}
  </span>
}
