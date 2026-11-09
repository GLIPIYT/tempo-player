/** Display-only: keep saved lyrics, token slots and alignment/cache identity intact. */
export function capitalizeLyricLines(text: string): string {
  return text.replace(/(^|\n)([^\p{L}\n]*)(\p{L})/gu, (_match, newline: string, prefix: string, letter: string) =>
    newline + prefix + letter.toLocaleUpperCase())
}
