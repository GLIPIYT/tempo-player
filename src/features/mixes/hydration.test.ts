import { describe, expect, it, vi } from 'vitest'
import { customMixRuleFingerprint } from './snapshot'
import { createCustomMixRule, type CustomMixGeneratedSelection, type CustomMixRule } from './types'
import { beginFastCustomMixLoad, isMixRequestVersionCurrent } from './hydration'
import { createMixForegroundGate, updateMixForegroundGate, waitForMixForegroundReady } from './foregroundGate'

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

  it('publishes each usable snapshot immediately and skips candidates when all snapshots are reusable', async () => {
    const slowSnapshot = deferred<CustomMixGeneratedSelection | null>()
    const startCandidateLoad = vi.fn(async () => ['library'])
    const ready = deferred<void>()
    const published: number[] = []
    const rules = [rule(1, 'Slow snapshot'), rule(2, 'Fast snapshot')]
    const load = beginFastCustomMixLoad(rules, {
      readSnapshot: (current) => current.id === 1 ? slowSnapshot.promise : Promise.resolve(selection(1_000)),
      loadCandidates: startCandidateLoad,
      emptyCandidates: [],
      isCurrent: () => true,
      needsCandidateLoad: (_rule, cached) => cached == null,
      onSnapshot: (current) => {
        published.push(current.id!)
        if (current.id === 2) ready.resolve()
      },
    })

    await ready.promise
    expect(published).toEqual([2])
    expect(startCandidateLoad).not.toHaveBeenCalled()
    slowSnapshot.resolve(selection(1_000))
    await load.snapshots
    await expect(load.candidates).resolves.toEqual([])
    expect(startCandidateLoad).not.toHaveBeenCalled()
  })

  it('starts candidate loading as soon as a missing snapshot needs regeneration', async () => {
    const slowSnapshot = deferred<CustomMixGeneratedSelection | null>()
    const startCandidateLoad = vi.fn(async () => ['library'])
    const rules = [rule(1, 'Slow snapshot'), rule(2, 'Missing snapshot')]
    const load = beginFastCustomMixLoad(rules, {
      readSnapshot: (current) => current.id === 1 ? slowSnapshot.promise : Promise.resolve(null),
      loadCandidates: startCandidateLoad,
      emptyCandidates: [],
      isCurrent: () => true,
      needsCandidateLoad: (_rule, cached) => cached == null,
      onSnapshot: () => undefined,
    })

    await expect(load.candidates).resolves.toEqual(['library'])
    expect(startCandidateLoad).toHaveBeenCalledOnce()
    slowSnapshot.resolve(selection(1_000))
    await load.snapshots
  })

  it('publishes a snapshot before foreground readiness and defers only candidate generation', async () => {
    const gate = createMixForegroundGate(9)
    const foregroundWait = waitForMixForegroundReady(gate)
    const published: number[] = []
    const fetchCandidates = vi.fn(async () => ['library'])
    const loadCandidates = async () => {
      await foregroundWait.promise
      return fetchCandidates()
    }
    const load = beginFastCustomMixLoad([rule(10, 'Cached while home loads')], {
      readSnapshot: async () => selection(1_000),
      loadCandidates,
      emptyCandidates: [],
      isCurrent: () => true,
      needsCandidateLoad: () => true,
      onSnapshot: (current) => published.push(current.id!),
    })

    await load.snapshots
    expect(published).toEqual([10])
    expect(fetchCandidates).not.toHaveBeenCalled()
    expect(gate.ready).toBe(false)

    updateMixForegroundGate(gate, true)
    await expect(load.candidates).resolves.toEqual(['library'])
    expect(fetchCandidates).toHaveBeenCalledOnce()
  })

  it('treats a snapshot read failure as a regeneration request', async () => {
    const startCandidateLoad = vi.fn(async () => ['library'])
    const load = beginFastCustomMixLoad([rule(5, 'Unreadable snapshot')], {
      readSnapshot: async () => { throw new Error('snapshot read failed') },
      loadCandidates: startCandidateLoad,
      emptyCandidates: [],
      isCurrent: () => true,
      needsCandidateLoad: (_rule, cached) => cached == null,
      onSnapshot: () => undefined,
    })

    await expect(load.candidates).resolves.toEqual(['library'])
    await load.snapshots
    expect(startCandidateLoad).toHaveBeenCalledOnce()
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
