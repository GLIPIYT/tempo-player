import { Fragment, useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { useNav } from '../../state/nav'
import type { UnifiedTrack } from '../../types/models'
import { resolveArtistView } from '../../utils/artistNavigation'

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
    const originView = view
    const destination = await resolveArtistView(track, name)
    if (sequence !== request.current) return
    setPending(null)
    if (currentIdentity.current !== identity || currentView.current !== originView) return
    onNavigate?.()
    navigate(destination)
  }

  if (!artists.length) return <>{t('Unknown artist')}</>
  return <>{artists.map((name, index) => (
    <Fragment key={`${name}:${index}`}>
      {index > 0 && ', '}
      <button type="button" className="artist-link" aria-busy={pending === name} onClick={() => { void open(name) }}>{name}</button>
    </Fragment>
  ))}</>
}
