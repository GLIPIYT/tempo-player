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
  /** Decide from each snapshot whether generating this rule needs the candidate library. */
  needsCandidateLoad?: (rule: CustomMixRule, selection: CustomMixGeneratedSelection | null) => boolean
}

export interface FastCustomMixLoad<TLibrary> {
  candidates: Promise<TLibrary>
  snapshots: Promise<void>
}

/** Publishes snapshots as they arrive and loads candidates only after a rule needs regeneration. */
export function beginFastCustomMixLoad<TLibrary>(
  rules: readonly CustomMixRule[],
  options: FastCustomMixLoadOptions<TLibrary>,
): FastCustomMixLoad<TLibrary> {
  const eligible = rules.filter((rule) => rule.id != null)
  let next = 0
  let candidateDecisionSettled = false
  let resolveCandidateDecision!: (required: boolean) => void
  const candidateDecision = new Promise<boolean>((resolve) => { resolveCandidateDecision = resolve })
  const settleCandidateDecision = (required: boolean) => {
    if (candidateDecisionSettled) return
    candidateDecisionSettled = true
    resolveCandidateDecision(required)
  }
  const worker = async (): Promise<void> => {
    while (next < eligible.length) {
      const rule = eligible[next++]
      if (!options.isCurrent(rule)) continue
      let selection: CustomMixGeneratedSelection | null = null
      try {
        selection = await options.readSnapshot(rule)
      } catch {
        // A failed or missing snapshot must still allow a fresh generation attempt.
      }
      if (!options.isCurrent(rule)) continue
      let needsCandidates = true
      try {
        needsCandidates = options.needsCandidateLoad?.(rule, selection) ?? true
      } catch {
        // Prefer attempting regeneration when snapshot cadence cannot be checked.
      }
      if (needsCandidates) settleCandidateDecision(true)
      if (selection && options.isCurrent(rule)) options.onSnapshot(rule, selection)
    }
  }
  const snapshots = Promise.all(Array.from(
    { length: Math.min(MAX_PARALLEL_SNAPSHOT_READS, eligible.length) },
    () => worker(),
  )).then(() => {
    settleCandidateDecision(false)
  }, (error: unknown) => {
    settleCandidateDecision(true)
    throw error
  })

  const candidates = (async (): Promise<TLibrary> => {
    const required = await candidateDecision
    return required ? options.loadCandidates() : options.emptyCandidates
  })()
  return { candidates, snapshots }
}
