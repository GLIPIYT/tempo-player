const MAX_PROGRESS_WIDTH = 420

/** Place the path in its row, center it on the text, or match the text bounds. */
export function resolveLyricProgressGeometry(
  row: Pick<DOMRectReadOnly, 'left' | 'width'>,
  text: Pick<DOMRectReadOnly, 'left' | 'width'>,
  alignment: 'left' | 'center' | 'right',
  clipToText: boolean,
  direction: 'left-to-right' | 'right-to-left' | 'center-out',
): { leftPx: number; widthPx: number } {
  const rowWidth = Math.max(0, row.width)
  const width = Math.min(MAX_PROGRESS_WIDTH, rowWidth)
  const left = alignment === 'left'
    ? 0
    : alignment === 'right'
      ? rowWidth - width
      : (rowWidth - width) / 2

  const textLeft = text.left - row.left
  if (!clipToText) {
    const pathLeft = direction === 'center-out'
      ? textLeft + (Math.max(0, text.width) - width) / 2
      : left
    return { leftPx: pathLeft, widthPx: width }
  }

  return { leftPx: textLeft, widthPx: Math.max(0, text.width) }
}
