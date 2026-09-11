import { useEffect, useRef } from 'react'
import type { Track } from '../../types/models'
import TrackMenu, { type TrackMenuHandle } from './TrackMenu'

export interface TrackContextRequest {
  x: number
  y: number
  track: Track
  tracks: Track[]
  index: number
}

interface TrackContextMenuProps {
  req: TrackContextRequest | null
  onClose: () => void
}

/**
 * Opens the full track menu at the cursor.
 *
 * One instance per page, re-targeted on every right-click, rather than a menu
 * per card: home cards live in grids and rails, where an extra element would
 * become an extra cell and shift the layout.
 */
export default function TrackContextMenu({ req, onClose }: TrackContextMenuProps) {
  const ref = useRef<TrackMenuHandle | null>(null)

  useEffect(() => {
    if (req) ref.current?.openAt(req.x, req.y)
  }, [req])

  if (!req) return null
  return (
    <div className="ctx-anchor">
      <TrackMenu
        // remount per request so a previous submenu or half-typed playlist name
        // cannot survive into the next opening
        key={`${req.track.id}:${req.x}:${req.y}`}
        ref={ref}
        hideTrigger
        track={req.track}
        tracks={req.tracks}
        index={req.index}
        onChanged={onClose}
      />
    </div>
  )
}
