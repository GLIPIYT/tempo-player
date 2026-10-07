const MAX_PROGRESS_WIDTH = 420

/** Place a capped progress path in its row, optionally restricting it to the rendered text. */
export function resolveLyricProgressGeometry(
  row: DOMRectReadOnly,
  text: DOMRectReadOnly,
  alignment: 'left' | 'center' | 'right',
  clipToText: boolean,
): { leftPx: number; widthPx: number } {
  const rowWidth = Math.max(0, row.width)
  const width = Math.min(MAX_PROGRESS_WIDTH, rowWidth)
  const left = alignment === 'left'
    ? 0
    : alignment === 'right'
      ? rowWidth - width
      : (rowWidth - width) / 2

  if (!clipToText) return { leftPx: left, widthPx: width }

  const clippedLeft = Math.max(left, text.left - row.left)
  const clippedRight = Math.min(left + width, text.right - row.left)
  return { leftPx: clippedLeft, widthPx: Math.max(0, clippedRight - clippedLeft) }
}
