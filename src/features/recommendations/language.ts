import { sha256Hex } from '../lyrics/sha256'
import type { LanguageEvidence } from './types'

export interface LyricEvidenceSource { source: string; translated?: boolean; instrumental?: boolean }
const letters = (text: string) => Array.from(text.matchAll(/\p{L}/gu)).length

/** Analyze only supplied attributable text. No recognition or network/model loading. */
export async function detectLyricLanguages(text: string, evidence: LyricEvidenceSource): Promise<LanguageEvidence> {
  const cleaned = text.normalize('NFKC').split(/\r?\n/u).map(line => line
    .replace(/\[\d{1,3}:\d{2}(?:[.:]\d+)?\]|<\d{1,3}:\d{2}(?:[.:]\d+)?>/gu, '')
    .replace(/^\s*\[(?:verse|chorus|bridge|intro|outro|hook|refrain|куплет|припев)[^\]]*\]\s*$/iu, '')
    .replace(/^\s*\[(?:ar|ti|al|by|offset|length):[^\]]*\]\s*$/iu, '').trim())
    .filter(Boolean).join('\n').slice(0, 100_000)
  const result: LanguageEvidence = { distribution: {}, confidence: 0, textHash: sha256Hex(cleaned),
    evidence: { ...evidence, algorithm: 'franc-min-6.2.0-blocks-v1', blocks: 0 }, unknownShare: 1 }
  const explicitlyTranslated = evidence.translated || /(?:^|\n)\s*(?:\[[^\]\n]*(?:translation|перевод)[^\]\n]*\]|(?:[a-zа-яё-]+\s+)?translation(?:\s*[:\-]|\s*$)|перевод(?:\s+(?:на|от)\s+[^\n]+)?(?:\s*[:\-]|\s*$)|translated (?:by|into)\s+[^\n]+)(?:\s*$|\n)/imu.test(cleaned)
  if (explicitlyTranslated) { result.evidence.translated = true; return result }
  if (evidence.instrumental || letters(cleaned) < 80) return result
  const { francAll } = await import('franc-min')
  // Small blocks retain mixed verses, including providers returning one plain paragraph.
  const words = cleaned.split(/\s+/u), blocks: string[] = []
  let block = ''
  for (const word of words) {
    block += `${word} `
    if (letters(block) >= 160) { blocks.push(block); block = '' }
  }
  if (letters(block) >= 80) blocks.push(block)
  else if (block && blocks.length) blocks[blocks.length - 1] += block
  if (!blocks.length) blocks.push(cleaned)
  const counts = new Map<string, number>()
  let unknown = 0, total = 0, reliability = 0
  for (const value of blocks.slice(0, 64)) {
    const weight = letters(value), matches = francAll(value, { minLength: 80 })
    total += weight
    const first = matches[0], second = matches[1]
    // Relative score gap is an ambiguity guard, never a claimed probability.
    const gap = first && second ? first[1] - second[1] : 0
    if (!first || first[0] === 'und' || gap < 0.04) { unknown += weight; continue }
    counts.set(first[0], (counts.get(first[0]) ?? 0) + weight)
    reliability += weight * Math.min(0.9, 0.4 + gap)
  }
  result.evidence.blocks = Math.min(64, blocks.length)
  result.unknownShare = total ? unknown / total : 1
  for (const [language, count] of counts) result.distribution[language] = count / total
  result.confidence = total ? Math.min(0.85, reliability / total) * Math.min(1, total / 320) : 0
  return result
}
