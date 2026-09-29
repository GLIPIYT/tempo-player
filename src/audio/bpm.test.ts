import { expect, it } from 'vitest'
import { estimateBpm } from './bpm'
it('keeps silence and deterministic unstructured noise below confidence threshold', () => {
  expect(estimateBpm(new Float32Array(16000 * 30), 16000).confidence).toBeLessThan(0.8)
  let seed = 42
  const noise = Float32Array.from({ length: 16000 * 30 }, () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 31 - 1 })
  expect(estimateBpm(noise, 16000).confidence).toBeLessThan(0.8)
})
it('finds a stable 120 BPM onset train but does not claim certainty about half tempo', () => {
  const pcm = new Float32Array(16000 * 30)
  for (let start = 0; start < pcm.length; start += 8000) for (let i = 0; i < 400; i++) pcm[start + i] = Math.exp(-i / 80)
  const result = estimateBpm(pcm, 16000)
  expect(result.value).toBeCloseTo(120, 0)
  expect(result.confidence).toBeLessThan(0.8)
  expect(result.confidence).toBeGreaterThan(0.2)
})
