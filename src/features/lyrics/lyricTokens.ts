/** Display-only spacing. Original provider/editor text and cache keys stay intact. */
export function lyricDisplayText(text: string): string {
  return text.replace(/\r\n?/gu, '\n').replace(/[^\S\n]+/gu, ' ')
    .replace(/([,;:!?，；：！？])(?=[\p{L}\p{N}])/gu, (punctuation: string, _match: string, offset: number, body: string) => {
      // Decimal numbers and clocks are not word boundaries: 3,14 and 12:30.
      if (/[,，:：]/u.test(punctuation) && /\p{N}/u.test(body[offset - 1] ?? '') && /\p{N}/u.test(body[offset + punctuation.length] ?? '')) return punctuation
      return `${punctuation} `
    })
    .replace(/(\.{2,}|…)(?=\p{L})/gu, '$1 ')
    .split('\n').map(line => line.trim()).join('\n')
}

export function lyricDisplayTokens(text: string): string[] {
  return lyricDisplayText(text).split(/(\s+)/u).filter(Boolean)
}

/** Shared by cue mapping and rendering, including punctuation attached to words. */
export function lyricWordTokens(text: string): string[] {
  return lyricDisplayText(text).match(/\S+/gu) ?? []
}
