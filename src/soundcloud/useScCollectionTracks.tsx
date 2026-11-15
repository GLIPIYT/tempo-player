import { useMemo } from 'react'
import { Download, Play } from 'lucide-react'
import { useT } from '../i18n'
import { usePlayerActions } from '../player'
import type { ScTrack } from '../types/models'
import { scTrackToUnified } from '../utils/unified'
import { openContextMenu, type ContextMenuRequest } from '../components/common/ContextMenu'
import { toast } from '../components/common/Toast'
import type { OnlineCollectionTrack } from '../components/common/OnlineCollectionTracks'
import { requestTrackCache } from './cacheJobs'
import { canPlaySoundCloudTrack } from './playability'

export function useScCollectionTracks(tracks: readonly ScTrack[]) {
  const t = useT()
  const player = usePlayerActions()
  const rows = useMemo((): OnlineCollectionTrack[] => tracks.map(track => ({
    source: 'soundcloud',
    sourceId: track.id,
    title: track.title,
    artists: [track.artist],
    album: null,
    durationSec: track.durationMs / 1000,
    coverPath: track.artworkUrl,
    playable: canPlaySoundCloudTrack(track),
  })), [tracks])
  const playableIndices = useMemo(() => rows.flatMap((track, index) => track.playable ? [index] : []), [rows])

  const play = (index = playableIndices[0]) => {
    const start = playableIndices.indexOf(index)
    if (start >= 0) player.playTracks(playableIndices.map(i => scTrackToUnified(tracks[i])), start)
  }

  const onMenu = (point: Pick<ContextMenuRequest, 'x' | 'y' | 'trigger'>, index: number) => {
    const track = tracks[index]
    openContextMenu({ ...point, title: track.title, track: rows[index], items: [
      { id: 'play', label: t('Play now'), icon: <Play size={13} />, disabled: !rows[index].playable, onSelect: () => play(index) },
      {
        id: 'cache',
        label: t('Cache track'),
        icon: <Download size={13} />,
        disabled: !/^[1-9]\d*$/.test(track.id),
        onSelect: () => {
          void requestTrackCache(track).then(outcome => {
            if (outcome === 'cached') toast.show(t('Cached'))
            else if (outcome === 'empty') toast.show(t('This track cannot be cached'), 'info')
          }).catch(error => toast.show(error instanceof Error ? error.message : String(error), 'error'))
        },
      },
    ] })
  }

  return { rows, play, onMenu, canPlay: playableIndices.length > 0 }
}
