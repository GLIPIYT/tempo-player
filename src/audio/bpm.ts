/** Bounded excerpts only; this never walks a full long track on the UI thread. */
export function estimateBpm(pcm: Float32Array, sampleRate: number): { value: number | null; confidence: number } {
  const none = { value: null, confidence: 0 }
  if (!Number.isFinite(sampleRate) || sampleRate < 1000 || pcm.length / sampleRate < 8) return none
  const hop = Math.round(sampleRate / 100)
  const count = Math.min(1000, Math.floor(pcm.length / hop))
  const estimates: { bpm: number; score: number; ambiguous: boolean }[] = []
  for (const fraction of [0.1, 0.45, 0.8]) {
    const start = Math.floor((pcm.length - count * hop) * fraction)
    const onset = new Float64Array(count)
    let previous = 0, energy = 0
    for (let frame = 0; frame < count; frame++) {
      let sum = 0
      for (let i = 0; i < hop; i += 8) sum += pcm[start + frame * hop + i] ** 2
      const rms = Math.sqrt(sum / Math.ceil(hop / 8))
      onset[frame] = Math.max(0, rms - previous)
      energy += onset[frame] ** 2
      previous = rms
    }
    if (energy < 1e-7) return none
    const correlations = new Map<number, number>()
    for (let lag = 25; lag <= 150; lag++) {
      let dot = 0, a = 0, b = 0
      for (let i = lag; i < count; i++) { dot += onset[i] * onset[i - lag]; a += onset[i] ** 2; b += onset[i - lag] ** 2 }
      correlations.set(lag, dot / Math.sqrt(a * b || 1))
    }
    const ranked = [...correlations].sort((a, b) => b[1] - a[1] || a[0] - b[0])
    const [lag, score] = ranked[0]
    const octave = Math.max(correlations.get(lag * 2) ?? 0, correlations.get(Math.round(lag / 2)) ?? 0)
    estimates.push({ bpm: 6000 / lag, score, ambiguous: octave >= score * 0.9 })
  }
  const sorted = estimates.map((e) => e.bpm).sort((a, b) => a - b)
  const stable = sorted[2] - sorted[0] < 4
  const score = Math.min(...estimates.map((e) => e.score))
  if (!stable || score < 0.5) return none
  return { value: sorted[1], confidence: Math.min(estimates.some((e) => e.ambiguous) ? 0.65 : 0.95, score) }
}
