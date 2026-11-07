/** Word boundaries follow the measured text advance, without inventing vocal timestamps. */
export function wordStartsFromWidths(tokens: readonly { width: number; word: boolean }[]): number[] {
  const total = tokens.reduce((sum, token) => sum + Math.max(0, token.width), 0)
  let advance = 0
  return tokens.flatMap(token => {
    const start = total > 0 ? advance / total : 0
    advance += Math.max(0, token.width)
    return token.word ? [start] : []
  })
}

export function wordIndexAtProgress(starts: readonly number[], progress: number): number {
  if (!starts.length || !Number.isFinite(progress)) return -1
  let lo = 0, hi = starts.length - 1, found = 0
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (starts[mid] <= progress) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  return found
}
