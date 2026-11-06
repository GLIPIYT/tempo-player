import { Fragment, useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { useT } from '../../i18n'
import { getKnownSoundCloudTrack } from '../../soundcloud/cacheMetadata'
import { useNav, type BaseView } from '../../state/nav'
import type { UnifiedTrack } from '../../types/models'
import { searchStore } from '../../utils/searchStore'

const normalizedName = (name: string) => name.trim().normalize('NFKC').toLocaleLowerCase()

async function artistView(track: UnifiedTrack, name: string): Promise<BaseView | null> {
  const expected = normalizedName(name)
  const local = await api.listArtists(name).catch(() => [])
  const match = local.find(artist => normalizedName(artist.name) === expected)
  if (match) return { name: 'artist', id: match.id }
  if (track.source === 'soundcloud') {
    const known = getKnownSoundCloudTrack(track.sourceId)
    if (known?.uploaderId && normalizedName(known.uploaderName ?? known.artist) === expected) {
      return { name: 'sc-artist', id: known.uploaderId }
    }
    const results = await api.scSearchArtists(name, 20, 0).catch(() => [])
    const artist = results.find(result => normalizedName(result.username) === expected)
    if (artist) return { name: 'sc-artist', id: artist.id }
  }
  return null
}

export default function ArtistLinks({ track, onNavigate }: { track: UnifiedTrack; onNavigate?: () => void }) {
  const t = useT()
  const { view, navigate } = useNav()
  const [pending, setPending] = useState<string | null>(null)
  const request = useRef(0)
  const identity = `${track.source}:${track.sourceId}`
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const currentView = useRef(view)
  currentView.current = view
  useEffect(() => () => { request.current += 1 }, [])
  const artists = track.artists.map(name => name.trim()).filter(Boolean)

  const open = async (name: string) => {
    const sequence = ++request.current
    setPending(name)
    const view = await artistView(track, name)
    if (sequence !== request.current) return
    setPending(null)
    if (currentIdentity.current !== identity || currentView.current !== view) return
    if (!view) searchStore.set(name)
    onNavigate?.()
    navigate(view ?? { name: 'search' })
  }

  if (!artists.length) return <>{t('Unknown artist')}</>
  return <>{artists.map((name, index) => (
    <Fragment key={`${name}:${index}`}>
      {index > 0 && ', '}
      <button type="button" className="artist-link" aria-busy={pending === name} onClick={() => { void open(name) }}>{name}</button>
    </Fragment>
  ))}</>
}
