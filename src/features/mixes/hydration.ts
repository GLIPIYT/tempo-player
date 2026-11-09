import type { CustomMixGeneratedSelection, CustomMixRule } from './types'

const MAX_PARALLEL_SNAPSHOT_READS = 4

/** Compare captured request versions, treating an unseen rule as version zero. */
export function isMixRequestVersionCurrent(
  currentVersion: number | undefined,
  capturedVersion: number | undefined,
): boolean {
  return (currentVersion ?? 0) === (capturedVersion ?? 0)
}

export interface FastCustomMixLoadOptions<TLibrary> {
  readSnapshot: (rule: CustomMixRule) => Promise<CustomMixGeneratedSelection | null>
  loadCandidates: () => Promise<TLibrary>
  emptyCandidates: TLibrary
  isCurrent: (rule: CustomMixRule) => boolean
  onSnapshot: (rule: CustomMixRule, selection: CustomMixGeneratedSelection) => void
}

export interface FastCustomMixLoad<TLibrary> {
  candidates: Promise<TLibrary>
  snapshots: Promise<void>
}

/** Starts cached snapshot reads before candidate loading and publishes each hit as it arrives. */
export function beginFastCustomMixLoad<TLibrary>(
  rules: readonly CustomMixRule[],
  options: FastCustomMixLoadOptions<TLibrary>,
): FastCustomMixLoad<TLibrary> {
  const eligible = rules.filter((rule) => rule.id != null && rule.refreshIntervalMinutes > 0)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < eligible.length) {
      const rule = eligible[next++]
      if (!options.isCurrent(rule)) continue
      let selection: CustomMixGeneratedSelection | null
      try {
        selection = await options.readSnapshot(rule)
      } catch {
        continue
      }
      if (selection && options.isCurrent(rule)) options.onSnapshot(rule, selection)
    }
  }
  const snapshots = Promise.all(Array.from(
    { length: Math.min(MAX_PARALLEL_SNAPSHOT_READS, eligible.length) },
    () => worker(),
  )).then(() => undefined)

  let candidates: Promise<TLibrary>
  try {
    candidates = rules.length > 0 ? Promise.resolve(options.loadCandidates()) : Promise.resolve(options.emptyCandidates)
  } catch (cause) {
    candidates = Promise.reject(cause)
  }
  return { candidates, snapshots }
}
