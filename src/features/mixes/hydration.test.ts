import { describe, expect, it } from 'vitest'
import { customMixRuleFingerprint } from './snapshot'
import { createCustomMixRule, type CustomMixGeneratedSelection, type CustomMixRule } from './types'
import { beginFastCustomMixLoad, isMixRequestVersionCurrent } from './hydration'

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
    const ready = deferred<void>()
    const published: number[] = []
    const rules = [rule(1, 'Slow snapshot'), rule(2, 'Fast snapshot')]
    const load = beginFastCustomMixLoad(rules, {
      readSnapshot: (current) => current.id === 1 ? slowSnapshot.promise : Promise.resolve(selection(1_000)),
      loadCandidates: () => candidateLoad.promise,
      emptyCandidates: [],
      isCurrent: () => true,
      onSnapshot: (current) => {
        published.push(current.id!)
        if (current.id === 2) ready.resolve()
      },
    })

    await ready.promise
    expect(published).toEqual([2])
    slowSnapshot.resolve(null)
    candidateLoad.resolve([])
    await Promise.all([load.snapshots, load.candidates])
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
