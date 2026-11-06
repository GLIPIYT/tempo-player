/**
 * Automatic mini-player peeks are reserved for a track reached by natural
 * playback completion. Other track changes, including user skips, stay quiet.
 */
export function shouldAutoPeekForTrackChange(
  reason: string,
  enabled: boolean,
  autoShowOnTrackChange: boolean,
): boolean {
  return enabled && autoShowOnTrackChange && reason === 'natural-end'
}
