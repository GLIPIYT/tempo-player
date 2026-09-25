import { useEffect, useState, type MouseEvent } from 'react'
import { Copy, Download, ExternalLink } from 'lucide-react'
import { useNav } from '../../state/nav'
import { useT } from '../../i18n'
import { openContextMenu, type ContextMenuItem } from './ContextMenu'
import { toast } from './Toast'
import ScArtwork from './ScArtwork'
import {
  getSaveJob,
  saveCollectionById,
  subscribeSave,
  type SaveJob,
} from '../../youtube/collectionSaver'

/**
 * An album, artist or playlist from YouTube Music, as a card.
 *
 * SoundCloud's cards cannot be reused for these: they take SoundCloud's own
 * types and do SoundCloud's own things. This is the same shape with its own.
 */
export default function YtCard({
  kind,
  id,
  name,
  sub,
  count,
  thumbnailUrl,
  fallbackUrls = [],
  pending = false,
}: {
  kind: 'album' | 'artist' | 'playlist'
  id: string
  name: string | null
  sub: string | null
  count: number | null
  thumbnailUrl: string | null
  fallbackUrls?: string[]
  pending?: boolean
}) {
  const t = useT()
  const { navigate } = useNav()
  const [saving, setSaving] = useState<SaveJob | null>(getSaveJob)

  // Only this card's own save, not whatever else happens to be running.
  useEffect(() => subscribeSave(() => setSaving(getSaveJob())), [])
  const mine = saving !== null && saving.id === id ? saving : null

  const browseUrl = `https://music.youtube.com/browse/${id}`

  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
    const items: ContextMenuItem[] = [
      {
        id: 'save',
        label: t('Save to library'),
        icon: <Download size={13} />,
        onSelect: () => {
          toast.show(t('Saving'))
          void saveCollectionById(id, name ?? '', browseUrl)
        },
      },
      {
        id: 'copy',
        label: t('Copy name'),
        icon: <Copy size={13} />,
        onSelect: () => void navigator.clipboard.writeText(name ?? ''),
      },
      {
        id: 'open',
        label: t('Open on YouTube Music'),
        icon: <ExternalLink size={13} />,
        onSelect: () => window.open(browseUrl, '_blank'),
      },
    ]
    openContextMenu({ x: e.clientX, y: e.clientY, title: name ?? '', items })
  }

  return (
    <button
      type="button"
      className="card sc-card"
      title={name ?? ''}
      onClick={() => navigate({ name: 'yt-collection', kind, id })}
      onContextMenu={onContextMenu}
    >
      <span className="sc-card-art">
        <ScArtwork
          url={thumbnailUrl}
          fallbackUrls={fallbackUrls}
          title={name ?? ''}
          pending={pending}
        />
        {mine ? (
          <span className="cache-badge">
            {mine.state === 'running'
              ? `${Math.round((mine.done / Math.max(1, mine.total)) * 100)}%`
              : '✓'}
          </span>
        ) : null}
      </span>
      <span className="card-title">{name ?? ''}</span>
      <span className="card-sub">{sub ?? ''}</span>
      <span className="card-sub">{count !== null ? `${count}` : ''}</span>
    </button>
  )
}
