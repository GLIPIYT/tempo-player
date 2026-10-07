const MAX_PROGRESS_WIDTH = 420

/** Place the fixed-width path in its row or match it exactly to the rendered text. */
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

  const textLeft = text.left - row.left
  return { leftPx: textLeft, widthPx: Math.max(0, text.width) }
}
