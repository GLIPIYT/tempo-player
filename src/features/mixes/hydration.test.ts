import { afterEach, describe, expect, it, vi } from 'vitest'
import { customMixRuleFingerprint } from './snapshot'
import { createCustomMixRule, type CustomMixGeneratedSelection, type CustomMixRule } from './types'
import { beginFastCustomMixLoad, isMixRequestVersionCurrent } from './hydration'

afterEach(() => vi.useRealTimers())

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => { resolve = finish })
  return { promise, resolve }
}

function rule(id: number, name: string): CustomMixRule {
  const value = createCustomMixRule(name)
  value.id = id
  value.refreshIntervalMinutes = 30
  return value
}

function selection(generatedAt: number): CustomMixGeneratedSelection {
  return { tracks: [], warnings: [], generatedAt, fromCache: true }
}

describe('fast custom mix hydration', () => {
  it('accepts a fresh rule at request version zero and rejects it after a newer request starts', () => {
    const capturedVersion = 0

    expect(isMixRequestVersionCurrent(undefined, capturedVersion)).toBe(true)
    expect(isMixRequestVersionCurrent(1, capturedVersion)).toBe(false)
  })

  it('publishes a ready snapshot while another snapshot and candidate loading are still pending', async () => {
    const slowSnapshot = deferred<CustomMixGeneratedSelection | null>()
    const candidateLoad = deferred<string[]>()
    const startCandidateLoad = vi.fn(() => candidateLoad.promise)
    const ready = deferred<void>()
    const published: number[] = []
    const rules = [rule(1, 'Slow snapshot'), rule(2, 'Fast snapshot')]
    const load = beginFastCustomMixLoad(rules, {
      readSnapshot: (current) => current.id === 1 ? slowSnapshot.promise : Promise.resolve(selection(1_000)),
      loadCandidates: startCandidateLoad,
      emptyCandidates: [],
      isCurrent: () => true,
      snapshotPriorityMs: 20,
      onSnapshot: (current) => {
        published.push(current.id!)
        if (current.id === 2) ready.resolve()
      },
    })

    await ready.promise
    expect(published).toEqual([2])
    expect(startCandidateLoad).not.toHaveBeenCalled()
    slowSnapshot.resolve(null)
    await load.snapshots
    candidateLoad.resolve([])
    await load.candidates
    expect(startCandidateLoad).toHaveBeenCalledOnce()
    await Promise.all([load.snapshots, load.candidates])
  })

  it('reads interval-zero snapshots and starts candidate loading after the bounded cache-first window', async () => {
    vi.useFakeTimers()
    const slowSnapshot = deferred<CustomMixGeneratedSelection | null>()
    const candidateLoad = vi.fn(async () => ['library'])
    const reads: number[] = []
    const published: number[] = []
    const mixRule = rule(5, 'Every open')
    mixRule.refreshIntervalMinutes = 0
    const load = beginFastCustomMixLoad([mixRule], {
      readSnapshot: async (current) => { reads.push(current.id!); return slowSnapshot.promise },
      loadCandidates: candidateLoad,
      emptyCandidates: [],
      isCurrent: () => true,
      snapshotPriorityMs: 50,
      onSnapshot: (current) => published.push(current.id!),
    })

    await Promise.resolve()
    expect(reads).toEqual([5])
    expect(candidateLoad).not.toHaveBeenCalled()
    slowSnapshot.resolve(selection(1_000))
    await load.snapshots
    expect(published).toEqual([5])
    expect(await load.candidates).toEqual(['library'])
    expect(candidateLoad).toHaveBeenCalledOnce()

    const hungSnapshot = deferred<CustomMixGeneratedSelection | null>()
    const deadlineLoad = vi.fn(async () => ['after-deadline'])
    const waiting = beginFastCustomMixLoad([rule(6, 'Slow read')], {
      readSnapshot: () => hungSnapshot.promise,
      loadCandidates: deadlineLoad,
      emptyCandidates: [],
      isCurrent: () => true,
      snapshotPriorityMs: 50,
      onSnapshot: () => undefined,
    })
    await vi.advanceTimersByTimeAsync(49)
    expect(deadlineLoad).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(waiting.candidates).resolves.toEqual(['after-deadline'])
    expect(deadlineLoad).toHaveBeenCalledOnce()
    hungSnapshot.resolve(null)
    await waiting.snapshots
    vi.useRealTimers()
  })

  it('drops snapshots that finish after their rule is edited or deleted', async () => {
    const editedSnapshot = deferred<CustomMixGeneratedSelection | null>()
    const deletedSnapshot = deferred<CustomMixGeneratedSelection | null>()
    const edited = rule(3, 'Before edit')
    const deleted = rule(4, 'Deleted')
    let currentRules = [edited, deleted]
    const published: number[] = []
    const load = beginFastCustomMixLoad(currentRules, {
      readSnapshot: (current) => current.id === 3 ? editedSnapshot.promise : deletedSnapshot.promise,
      loadCandidates: async () => [],
      emptyCandidates: [],
      isCurrent: (candidate) => currentRules.some((current) => current.id === candidate.id
        && customMixRuleFingerprint(current) === customMixRuleFingerprint(candidate)),
      onSnapshot: (current) => { published.push(current.id!) },
    })

    const changed = { ...edited, description: 'After edit' }
    currentRules = [changed]
    editedSnapshot.resolve(selection(1_000))
    deletedSnapshot.resolve(selection(1_000))
    await Promise.all([load.snapshots, load.candidates])

    expect(published).toEqual([])
  })
})
