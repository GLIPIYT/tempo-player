import { useNav } from '../../state/nav'
import ScArtwork from './ScArtwork'

/**
 * An album, artist or playlist from YouTube Music, as a card.
 *
 * SoundCloud's cards cannot be reused for these: they take SoundCloud's own
 * types and do SoundCloud's own things - caching a playlist, opening a
 * SoundCloud page. This is the same shape with none of that.
 */
export default function YtCard({
  kind,
  id,
  name,
  sub,
  count,
  thumbnailUrl,
  pending = false,
}: {
  kind: 'album' | 'artist' | 'playlist'
  id: string
  name: string | null
  sub: string | null
  count: number | null
  thumbnailUrl: string | null
  pending?: boolean
}) {
  const { navigate } = useNav()
  return (
    <button
      type="button"
      className="card sc-card"
      title={name ?? ''}
      onClick={() => navigate({ name: 'yt-collection', kind, id })}
    >
      <span className="sc-card-art">
        <ScArtwork url={thumbnailUrl} title={name ?? ''} pending={pending} />
      </span>
      <span className="card-title">{name ?? ''}</span>
      <span className="card-sub">{sub ?? ''}</span>
      <span className="card-sub">{count !== null ? `${count}` : ''}</span>
    </button>
  )
}
