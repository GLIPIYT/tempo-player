import type { AnalysisPcm } from '../../../audio/decodeForAnalysis'
import type { AudioIdentity } from './contract'

export interface AnalysisPcmLease {
  pcm: AnalysisPcm
  release(): void
}

interface DecodeEntry {
  controller: AbortController
  references: number
  settled: boolean
  promise: Promise<AnalysisPcm | null>
}

const entries = new Map<string, DecodeEntry>()

function cacheKey(identity: AudioIdentity): string {
  return JSON.stringify([identity.fingerprint, identity.absolutePath, identity.fileSize, identity.durationSec,
    identity.sampleRate, identity.channels])
}

function aborted(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Analysis audio decode aborted', 'AbortError')
}

/** Share one decoded mono buffer between concurrent lyric analyzers until both release it. */
export function acquireAnalysisPcm(identity: AudioIdentity, signal: AbortSignal,
  decode: (identity: AudioIdentity, signal: AbortSignal) => Promise<AnalysisPcm | null>): Promise<AnalysisPcmLease | null> {
  if (signal.aborted) return Promise.reject(aborted(signal))

  const key = cacheKey(identity)
  let entry = entries.get(key)
  if (!entry) {
    const controller = new AbortController()
    const created: DecodeEntry = { controller, references: 0, settled: false, promise: Promise.resolve(null) }
    created.promise = Promise.resolve().then(() => decode(identity, controller.signal)).then(value => {
      created.settled = true
      if (value === null && created.references === 0 && entries.get(key) === created) entries.delete(key)
      return value
    }, error => {
      created.settled = true
      if (entries.get(key) === created) entries.delete(key)
      throw error
    })
    entries.set(key, created)
    entry = created
  }

  entry.references += 1
  let completed = false
  const releaseReference = () => {
    if (completed) return
    completed = true
    entry!.references -= 1
    if (entry!.references === 0) {
      if (!entry!.settled) entry!.controller.abort()
      if (entries.get(key) === entry) entries.delete(key)
    }
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (completed) return
      const mustWaitForDecode = !entry!.settled && entry!.references === 1
      const reason = aborted(signal)
      cleanup()
      releaseReference()
      if (mustWaitForDecode) {
        // Preserve the decode lane's ownership/debt when its underlying decoder
        // cannot stop immediately after the last consumer cancels.
        entry!.promise.then(() => reject(reason), () => reject(reason))
      } else reject(reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })

    entry!.promise.then(value => {
      if (completed) return
      cleanup()
      if (signal.aborted) {
        releaseReference()
        reject(aborted(signal))
        return
      }
      if (value === null) {
        releaseReference()
        resolve(null)
        return
      }
      let released = false
      resolve({
        pcm: value,
        release: () => {
          if (released) return
          released = true
          releaseReference()
        },
      })
    }, error => {
      if (completed) return
      cleanup()
      releaseReference()
      reject(error)
    })
  })
}
