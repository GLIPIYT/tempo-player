import type { Playlist } from '../../types/models'
import { useT } from '../../i18n'
import { playlistDisplayName } from '../../utils/playlists'
import DeleteRuleDialog from './DeleteRuleDialog'

export default function DeletePlaylistDialog({ playlist, onDelete, onClose }: {
  playlist: Playlist
  onDelete: () => Promise<void>
  onClose: (deleted?: boolean) => void
}) {
  const t = useT()
  return <DeleteRuleDialog kind="playlist" name={playlistDisplayName(playlist, playlist.name, t)} coverPath={playlist.coverPath ?? null} onDelete={onDelete} onClose={onClose} />
}
