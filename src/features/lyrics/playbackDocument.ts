import type { LyricsOverride } from '../../types/models'
import type { LyricsEditorDocument } from './editorDocument'
import { toPlaybackLrc } from './editorDocument'

/** The retained editor snapshot may belong to a different active provider pin. */
export function activeOverrideDocument(pinned: LyricsOverride): LyricsEditorDocument | null {
  if (pinned.isActive === false || !pinned.editorDocument) return null
  const edited = pinned.editedVersion
  if (edited) {
    return edited.provider === pinned.provider && edited.lrc.trim() === pinned.lrc.trim()
      && edited.sourceArtist === pinned.sourceArtist && edited.sourceTitle === pinned.sourceTitle
      ? pinned.editorDocument : null
  }
  return toPlaybackLrc(pinned.editorDocument).trim() === pinned.lrc.trim() ? pinned.editorDocument : null
}
