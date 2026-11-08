import type { VocalAnalysis, VocalTimingEvidence, VocalChunk } from './analysis/vocalContract'
import type { LyricWordTiming } from './wordTiming'

interface Frame { time: number; voice: number; energy: number; flux: number }
const chunksByAnalysis = new WeakMap<VocalAnalysis, readonly VocalChunk[]>()
const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value))

/** Missing cache chunks are unknown, never silent. Cache coordinates stay in media time. */
function framesBetween(evidence: VocalTimingEvidence | null | undefined, start: number, end: number): Frame[] | null {
  if (!evidence || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  const { analysis, offsetMs } = evidence, hop = analysis.hopSec, offset = offsetMs / 1000
  if (hop !== .02 || !Number.isFinite(offset)) return null
  let chunks = chunksByAnalysis.get(analysis)
  if (!chunks) { chunks = [...analysis.chunks].sort((a, b) => a.startSec - b.startSec); chunksByAnalysis.set(analysis, chunks) }
  const frames: Frame[] = []
  let chunkIndex = 0
  for (let time = start; time < end - .00001; time += hop) {
    const center = Math.min(end - .00001, time + hop / 2), media = center - offset
    while (chunks[chunkIndex] && chunks[chunkIndex].endSec <= media) chunkIndex++
    const chunk = chunks[chunkIndex]
    if (!chunk || media < chunk.startSec - .00001 || media >= chunk.endSec) return null
    const index = Math.floor(Math.max(0, media - chunk.startSec) / hop)
    if (index >= chunk.voice.length || index >= chunk.energy.length || index >= chunk.flux.length) return null
    frames.push({ time, voice: chunk.voice[index] / 255, energy: chunk.energy[index] / 255, flux: chunk.flux[index] / 255 })
  }
  return frames
}

/** A sustained vocal exit near a text estimate; not a recognized word boundary. */
export function vocalPhraseEnd(evidence: VocalTimingEvidence | null | undefined, start: number, expected: number,
  limit: number, sourceWordFloor: number): number | null {
  if (!evidence || expected <= start) return null
  const radius = clamp((expected - start) * .25, .6, 1.6)
  const searchStart = Math.max(start + .2, sourceWordFloor + .12, expected - radius)
  const searchEnd = Math.min(limit - .32, expected + radius)
  if (searchEnd <= searchStart) return null
  const frames = framesBetween(evidence, Math.max(start, searchStart - .2), searchEnd + .32)
  if (!frames) return null
  const candidates: number[] = []
  for (let index = 9; index + 16 <= frames.length; index++) {
    const frame = frames[index]
    if (frame.time < searchStart || frame.time > searchEnd || frame.voice >= .35) continue
    const before = frames.slice(index - 9, index), after = frames.slice(index, index + 16)
    if (before.filter(item => item.voice >= .6).length < 7 || after.some(item => item.voice >= .45)
      || after.reduce((sum, item) => sum + item.voice, 0) / after.length > .25) continue
    // A single falling edge contributes only one candidate.
    if (!candidates.length || frame.time - candidates.at(-1)! > .3) candidates.push(frame.time)
  }
  candidates.sort((a, b) => Math.abs(a - expected) - Math.abs(b - expected))
  if (!candidates.length || candidates.length > 1 && Math.abs(candidates[1] - expected) - Math.abs(candidates[0] - expected) < .15) return null
  return clamp(candidates[0], start + .12, limit)
}

/** Acoustic hints only reshape estimated slots. Every cue remains explicitly estimated. */
export function refineEstimatedWords(cues: readonly (LyricWordTiming | null)[], evidence?: VocalTimingEvidence | null): (LyricWordTiming | null)[] {
  const present = cues.filter((cue): cue is LyricWordTiming => !!cue)
  if (present.length < 2 || present.some(cue => cue.source !== 'estimated')) return [...cues]
  const start = present[0].timeSec, end = present.at(-1)!.endTimeSec, span = end - start
  if (span > 30 || present.length > 200) return [...cues]
  const frames = framesBetween(evidence, start, end)
  if (!frames || frames.length < 10 || frames.filter(frame => frame.voice >= .55).length < frames.length * .2) return [...cues]
  const weights = frames.map(frame => .3 + .7 * frame.voice)
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const boundary = (expected: number): number => {
    const target = total * (expected - start) / span
    let cumulative = 0, index = 0
    while (index < weights.length - 1 && cumulative + weights[index] < target) cumulative += weights[index++]
    const mapped = frames[index].time + .02 * clamp((target - cumulative) / weights[index], 0, 1)
    const center = clamp(mapped, expected - .22, expected + .22)
    // Percussion also produces flux peaks. Restrict nudges to a voiced region,
    // require a prominent peak, and never move a boundary by more than 100 ms.
    const neighborhood = frames.filter(frame => Math.abs(frame.time - center) <= .1 && frame.voice >= .5)
    const baseline = neighborhood.length ? neighborhood.reduce((sum, frame) => sum + frame.flux, 0) / neighborhood.length : 1
    let chosen = center, best = .15
    for (const frame of neighborhood) {
      const score = frame.flux - baseline - Math.abs(frame.time - center) * 1.2
      if (score > best) { best = score; chosen = frame.time }
    }
    return clamp(chosen, expected - .25, expected + .25)
  }
  const minSpan = Math.min(.06, span / present.length / 2)
  const edges = [start]
  for (let index = 1; index < present.length; index++) edges.push(clamp(boundary(present[index].timeSec),
    edges[index - 1] + minSpan, end - (present.length - index) * minSpan))
  edges.push(end)
  let index = 0
  return cues.map(cue => cue ? { timeSec: edges[index], endTimeSec: edges[++index], source: 'estimated' } : null)
}
