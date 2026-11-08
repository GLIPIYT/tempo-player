/** Locate a viewport in laid-out rows without scanning the whole song. */
export function lyricPaintRange(count: number, top: number, bottom: number, rowTop: (index: number) => number) {
  const after = (edge: number) => {
    let lo = 0, hi = count
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (rowTop(mid) <= edge) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  return { start: Math.max(0, after(top) - 1), end: Math.min(count, after(bottom) + 1) }
}
