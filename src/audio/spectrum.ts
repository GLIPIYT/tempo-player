import { getEngine } from '../player/engine'

/**
 * Live spectrum for the visualiser: 64 log-spaced bins, normalised to 0..1.
 *
 * One sampling loop serves every canvas, because subscribing twice must not
 * mean sampling twice. The loop only runs while somebody is listening, and it
 * drops to a slow poll once the input has been silent for a while, so a paused
 * player costs nothing.
 *
 * The bins are pulled from the engine's analyser rather than pushed from an
 * audio thread. In a browser the FFT already runs off the main thread inside
 * the AnalyserNode, so there is nothing to offload; what is worth keeping is
 * the contract - a fixed-size array of 0..1 values, and one shared source for
 * any number of consumers.
 */

export type SpectrumListener = (bins: Float32Array) => void

/** Bins handed to listeners, before a canvas interpolates to its bar count. */
export const SPECTRUM_BINS = 64

/** Below this is rumble and DC, and the log bins get uselessly wide. */
const MIN_HZ = 50

/** Throttle for the sampling loop. The analyser's own rate is unrelated. */
const SAMPLE_INTERVAL_MS = 1000 / 60

/** Silence tolerated before the loop gives up its animation frame. */
const PARK_AFTER_MS = 1200

/** Poll period while parked - only cheap byte copies happen this slowly. */
const POLL_MS = 250

/** Peak of the raw byte spectrum treated as audible. */
const ENERGY_PEAK = 4

/** Frame-to-frame inertia of the bins, applied at the data level. */
const SMOOTH_KEEP = 0.55
const SMOOTH_NEW = 0.45

/** Full scale on the analyser's byte output. */
const BYTE_SCALE = 255

const INV_LOG_9 = 1 / Math.log(10)

const listeners = new Set<SpectrumListener>()
/** Raw magnitude per output bin, rebuilt from scratch every sample. */
const raw = new Float32Array(SPECTRUM_BINS)
/** What listeners receive; this is the array that carries the inertia. */
const bins = new Float32Array(SPECTRUM_BINS)

let freq: Uint8Array<ArrayBuffer> | null = null
let rafId = 0
let pollId = 0
let lastFrameAt = 0
let lastSampleAt = 0
let silentForMs = 0

/**
 * Folds the analyser's linearly spaced bins into 64 log-spaced ones and
 * returns the peak, which is what tells the loop whether to keep running.
 */
function readAnalyser(analyser: AnalyserNode): number {
  const count = analyser.frequencyBinCount
  if (!freq || freq.length !== count) freq = new Uint8Array(count)
  analyser.getByteFrequencyData(freq)

  const nyquist = Math.max(1, analyser.context.sampleRate / 2)
  const logMin = Math.log(MIN_HZ)
  const logRange = Math.max(1e-3, Math.log(nyquist) - logMin)

  raw.fill(0)
  let peak = 0
  for (let i = 0; i < count; i += 1) {
    const value = freq[i]
    if (value === 0) continue
    if (value > peak) peak = value
    // Linear spacing leaves almost all the energy in the first few bins, which
    // reads as two bars stuck to the left edge. Log spacing is what makes it
    // look like music.
    const hz = (i * nyquist) / count
    if (hz < MIN_HZ) continue
    const pos = Math.min(0.999, (Math.log(hz) - logMin) / logRange)
    const idx = (pos * SPECTRUM_BINS) | 0
    if (value > raw[idx]) raw[idx] = value
  }
  return peak
}

/** Log compression, then inertia: bars jump up and settle back down. */
function compressAndSmooth(): void {
  for (let i = 0; i < SPECTRUM_BINS; i += 1) {
    const v = Math.min(1, raw[i] / BYTE_SCALE)
    const logV = Math.log(1 + v * 9) * INV_LOG_9
    bins[i] = bins[i] * SMOOTH_KEEP + logV * SMOOTH_NEW
  }
}

function emit(): void {
  for (const listener of listeners) listener(bins)
}

/** One sample. Returns true while there is still something to hear. */
function sample(): boolean {
  const analyser = getEngine()?.getAnalyser() ?? null
  let peak = 0
  // No analyser means nothing is routed - a streamed track, or the graph was
  // abandoned. Decay to zero rather than freezing on the last frame.
  if (analyser) peak = readAnalyser(analyser)
  else raw.fill(0)
  compressAndSmooth()
  emit()
  return peak >= ENERGY_PEAK
}

function frame(now: number): void {
  rafId = 0
  if (listeners.size === 0) return
  if (document.hidden) {
    // rAF is throttled to a crawl while hidden, so just keep the chain alive
    lastFrameAt = now
    rafId = requestAnimationFrame(frame)
    return
  }

  const dt = lastFrameAt === 0 ? 16 : Math.min(250, now - lastFrameAt)
  lastFrameAt = now

  // Throttled to 60 Hz on purpose: the smoothing is per-sample, so on a 120 Hz
  // display an unthrottled loop would make the same setting feel twice as
  // twitchy.
  if (now - lastSampleAt >= SAMPLE_INTERVAL_MS) {
    lastSampleAt = now
    if (sample()) silentForMs = 0
  }
  silentForMs += dt

  if (silentForMs < PARK_AFTER_MS) {
    rafId = requestAnimationFrame(frame)
  } else {
    // Silent long enough to be worth giving up the frame; the tail is already
    // flat by now, so nothing is lost by stopping the draws.
    pollId = window.setTimeout(poll, POLL_MS)
  }
}

function poll(): void {
  pollId = 0
  if (listeners.size === 0) return
  if (document.hidden) {
    pollId = window.setTimeout(poll, POLL_MS)
    return
  }
  lastFrameAt = 0
  if (sample()) {
    silentForMs = 0
    rafId = requestAnimationFrame(frame)
  } else {
    pollId = window.setTimeout(poll, POLL_MS)
  }
}

function start(): void {
  if (rafId !== 0 || pollId !== 0) return
  lastFrameAt = 0
  lastSampleAt = 0
  silentForMs = 0
  rafId = requestAnimationFrame(frame)
}

function stop(): void {
  if (rafId !== 0) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
  if (pollId !== 0) {
    window.clearTimeout(pollId)
    pollId = 0
  }
  // leave nothing stale behind for whoever subscribes next
  bins.fill(0)
  raw.fill(0)
}

/**
 * Subscribes to the spectrum and returns the unsubscribe function. The sampling
 * loop stops once the last listener has gone.
 *
 * The array handed to the listener is reused between calls and is only valid
 * for the duration of the callback - copy it if you need to keep it.
 */
export function subscribeSpectrum(listener: SpectrumListener): () => void {
  listeners.add(listener)
  // The tap needs a graph, and a graph is only ever built for the local
  // channel. Asking for one here is what turns the visualiser on.
  getEngine()?.enableGraph()
  start()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stop()
  }
}
