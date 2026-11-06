/** Accept titles whose letters are mostly Latin or Cyrillic. */
export function hasSupportedRecommendationTitle(title: string): boolean {
  if (typeof title !== 'string') return false
  const letters = title.match(/\p{L}/gu) ?? []
  if (letters.length === 0) return true

  let supported = 0
  for (const letter of letters) {
    if (/\p{Script=Latin}/u.test(letter) || /\p{Script=Cyrillic}/u.test(letter)) supported += 1
  }

  return supported / letters.length >= 0.5
}
