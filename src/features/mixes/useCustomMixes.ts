import { useCallback, useEffect, useRef, useState } from 'react'
import type { HourMix } from '../../utils/hourMixes'
import type { CustomMixCandidate, CustomMixGenerationReason, CustomMixRule } from './types'
import { customMixService } from './service'
import { customMixRuleFingerprint, shouldRegenerateCustomMixSelection } from './snapshot'
import { beginFastCustomMixLoad, isMixRequestVersionCurrent } from './hydration'
import type { CustomMixMemoryState } from './service'
import {
  createMixForegroundGate,
  updateMixForegroundGate,
  waitForMixForegroundReady,
  type MixForegroundGate,
  type MixForegroundWait,
} from './foregroundGate'

const OVERDUE_RETRY_MS = 60_000
const MAX_PARALLEL_GENERATIONS = 2
let activeGenerations = 0
const generationWaiters: Array<() => void> = []

function mixesFromMemory(memory: CustomMixMemoryState): HourMix[] {
  const rules = new Map(memory.rules.flatMap((rule) => rule.id == null ? [] : [[rule.id, rule] as const]))
  return memory.selections.flatMap(({ ruleId, fingerprint, selection }) => {
    const rule = rules.get(ruleId)
    if (!rule || fingerprint !== customMixRuleFingerprint(rule)) return []
    return [{ key: `custom:${ruleId}`, kind: 'custom', title: rule.name, description: rule.description,
      tracks: selection.tracks, rule, warnings: selection.warnings, generatedAt: selection.generatedAt }]
  })
}

async function withGenerationSlot<T>(job: () => Promise<T>): Promise<T> {
  if (activeGenerations >= MAX_PARALLEL_GENERATIONS) {
    await new Promise<void>((resolve) => generationWaiters.push(resolve))
  } else {
    activeGenerations += 1
  }
  try {
    return await job()
  } finally {
    const next = generationWaiters.shift()
    if (next) next()
    else activeGenerations -= 1
  }
}

export function useCustomMixes(
  libraryVersion: number,
  editorOpen = false,
  foregroundReady = false,
) {
  const memoryRef = useRef<CustomMixMemoryState | null>(null)
  if (memoryRef.current === null) memoryRef.current = customMixService.getMemoryState()
  const foregroundGateRef = useRef<MixForegroundGate | null>(null)
  if (foregroundGateRef.current === null || foregroundGateRef.current.libraryVersion !== libraryVersion) {
    foregroundGateRef.current = createMixForegroundGate(libraryVersion, foregroundGateRef.current !== null)
  }
  const foregroundGate = foregroundGateRef.current
  const initialMemory = memoryRef.current
  const [revision, setRevision] = useState(0)
  const [rules, setRules] = useState<CustomMixRule[]>(initialMemory.rules)
  const [candidates, setCandidates] = useState<CustomMixCandidate[]>([])
  const [mixes, setMixes] = useState<HourMix[]>(() => mixesFromMemory(initialMemory))
  const [error, setError] = useState('')
  const rulesRef = useRef<CustomMixRule[]>(initialMemory.rules)
  const candidatesRef = useRef<CustomMixCandidate[]>([])
  const generatedAtRef = useRef(new Map(initialMemory.selections.map(({ ruleId, selection }) => [ruleId, selection.generatedAt])))
  const mixRequestVersionRef = useRef(new Map<number, number>())
  const firstLoadRef = useRef(true)
  const mountedRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleTimerRef = useRef<() => void>(() => undefined)

  const makeMix = useCallback((rule: CustomMixRule, tracks: HourMix['tracks'], warnings: string[], generatedAt: number): HourMix => ({
    key: `custom:${rule.id}`,
    kind: 'custom',
    title: rule.name,
    description: rule.description,
    tracks,
    rule,
    warnings,
    generatedAt,
  }), [])

  const generateMix = useCallback(async (
    rule: CustomMixRule,
    pool: readonly CustomMixCandidate[],
    reason: CustomMixGenerationReason,
    isActive: () => boolean = () => true,
  ): Promise<HourMix | null> => {
    const fingerprint = customMixRuleFingerprint(rule)
    const requestVersion = rule.id == null
      ? null
      : (mixRequestVersionRef.current.get(rule.id) ?? 0) + 1
    if (rule.id != null) mixRequestVersionRef.current.set(rule.id, requestVersion!)
    const isCurrent = () => mountedRef.current && isActive() && rule.id != null
      && mixRequestVersionRef.current.get(rule.id) === requestVersion
      && rulesRef.current.some((current) => current.id === rule.id
        && customMixRuleFingerprint(current) === fingerprint)
    const result = await withGenerationSlot(async () => {
      if (!isCurrent()) return null
      return customMixService.generate(rule, pool, { reason })
    })
    if (!result || !isCurrent()) return null
    const mix = makeMix(rule, result.tracks, result.warnings, result.generatedAt)
    if (rule.id != null) generatedAtRef.current.set(rule.id, result.generatedAt)
    setMixes((current) => {
      if (!isCurrent()) return current
      const next = current.filter((item) => item.key !== mix.key)
      return [...next, mix]
    })
    return mix
  }, [makeMix])

  scheduleTimerRef.current = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    if (!mountedRef.current) return
    const now = Date.now() / 1000
    const deadlines = rulesRef.current.flatMap((rule) => {
      if (rule.id == null || rule.refreshIntervalMinutes <= 0) return []
      const generatedAt = generatedAtRef.current.get(rule.id)
      return generatedAt == null ? [] : [generatedAt + rule.refreshIntervalMinutes * 60]
    })
    if (deadlines.length === 0) return
    const dueAt = Math.min(...deadlines)
    const delay = dueAt <= now
      ? OVERDUE_RETRY_MS
      : Math.max(1_000, (dueAt - now) * 1000)
    timerRef.current = setTimeout(() => {
      const scheduledAt = Date.now() / 1000
      const dueRules = rulesRef.current.filter((rule) => {
        if (rule.id == null || rule.refreshIntervalMinutes <= 0) return false
        const generatedAt = generatedAtRef.current.get(rule.id)
        return generatedAt != null && generatedAt + rule.refreshIntervalMinutes * 60 <= scheduledAt
      })
      if (dueRules.length === 0) {
        scheduleTimerRef.current()
        return
      }
      void customMixService.getCandidates()
        .then(async (library) => {
          if (!mountedRef.current) return
          candidatesRef.current = library
          setCandidates(library)
          await Promise.all(dueRules.map((rule) => generateMix(rule, library, 'scheduled')))
        })
        .catch((cause) => { if (mountedRef.current) setError(String(cause)) })
        .finally(() => scheduleTimerRef.current())
    }, delay)
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  useEffect(() => {
    const gate = foregroundGateRef.current
    if (gate?.libraryVersion !== libraryVersion) return
    updateMixForegroundGate(gate, foregroundReady, editorOpen)
  }, [libraryVersion, foregroundReady, editorOpen])

  useEffect(() => {
    let cancelled = false
    let candidateWait: MixForegroundWait | null = null
    void customMixService.list()
      .then(async (saved) => {
        if (cancelled) return
        rulesRef.current = saved
        setRules(saved)
        setMixes((current) => current.filter((mix) => saved.some((rule) =>
          mix.key === `custom:${rule.id}` && mix.rule != null
          && customMixRuleFingerprint(mix.rule) === customMixRuleFingerprint(rule))))
        setError('')
        const reason: CustomMixGenerationReason = firstLoadRef.current ? 'open' : 'scheduled'

        const hydrationVersions = new Map(saved.flatMap((rule) => rule.id == null
          ? []
          : [[rule.id, mixRequestVersionRef.current.get(rule.id) ?? 0] as const]))
        const rulesNeedingGeneration = new Set<number>()
        const isCurrentRule = (rule: CustomMixRule) => !cancelled && mountedRef.current
          && rule.id != null
          && isMixRequestVersionCurrent(
            mixRequestVersionRef.current.get(rule.id), hydrationVersions.get(rule.id),
          )
          && rulesRef.current.some((current) => current.id === rule.id
            && customMixRuleFingerprint(current) === customMixRuleFingerprint(rule))
        let candidatesReady = false
        let generationsComplete = false
        const load = beginFastCustomMixLoad(saved, {
          readSnapshot: (rule) => customMixService.getDisplayableSnapshot(rule),
          loadCandidates: async () => {
            candidateWait = waitForMixForegroundReady(foregroundGate)
            await candidateWait.promise
            if (cancelled || !mountedRef.current) return []
            return customMixService.getCandidates()
          },
          emptyCandidates: candidatesRef.current,
          isCurrent: isCurrentRule,
          needsCandidateLoad: (rule, selection) => {
            const needsGeneration = shouldRegenerateCustomMixSelection(rule, selection, reason)
            if (needsGeneration && rule.id != null) rulesNeedingGeneration.add(rule.id)
            return editorOpen || needsGeneration
          },
          onSnapshot: (rule, selection) => {
            if (rule.id == null) return
            const existingGeneratedAt = generatedAtRef.current.get(rule.id)
            if (existingGeneratedAt != null && existingGeneratedAt > selection.generatedAt) return
            generatedAtRef.current.set(rule.id, selection.generatedAt)
            const mix = makeMix(rule, selection.tracks, selection.warnings, selection.generatedAt)
            setMixes((current) => {
              if (!isCurrentRule(rule)) return current
              const existing = current.find((item) => item.key === mix.key)
              if (existing?.generatedAt != null && existing.generatedAt > selection.generatedAt) return current
              return [...current.filter((item) => item.key !== mix.key), mix]
            })
            if (candidatesReady && generationsComplete) scheduleTimerRef.current()
          },
        })
        void load.snapshots.catch((cause) => { if (!cancelled) setError(String(cause)) })
        const library = await load.candidates
        // Candidate loading may finish before a slower snapshot read. Collect
        // every rule's decision before choosing which rules to regenerate.
        await load.snapshots
        if (cancelled) return
        firstLoadRef.current = false
        candidatesRef.current = library
        setCandidates(library)
        candidatesReady = true
        const generationRules = saved.filter((rule) => rule.id != null && rulesNeedingGeneration.has(rule.id))
        let next = 0
        const worker = async () => {
          while (!cancelled && next < generationRules.length) {
            const rule = generationRules[next++]
            await generateMix(rule, library, reason, () => !cancelled)
          }
        }
        await Promise.all([worker(), worker()])
        if (cancelled) return
        generationsComplete = true
        scheduleTimerRef.current()
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause))
        // Candidate loading can fail while valid snapshot reads are still in flight.
        // Keep those independent reads alive until the effect is actually replaced.
      })
    return () => {
      cancelled = true
      candidateWait?.cancel()
    }
  }, [libraryVersion, revision, editorOpen, generateMix, makeMix, foregroundGate])

  useEffect(() => {
    if (!editorOpen || rules.length > 0) return
    let cancelled = false
    void customMixService.getCandidates().then((library) => {
      if (cancelled) return
      candidatesRef.current = library
      setCandidates(library)
    }).catch((cause) => {
      if (!cancelled) setError(String(cause))
    })
    return () => { cancelled = true }
  }, [editorOpen, libraryVersion, revision, rules.length])

  const save = useCallback(async (rule: CustomMixRule) => {
    const saved = await customMixService.save(rule)
    rulesRef.current = [...rulesRef.current.filter((current) => current.id !== saved.id), saved]
    if (saved.id != null) {
      mixRequestVersionRef.current.set(saved.id, (mixRequestVersionRef.current.get(saved.id) ?? 0) + 1)
      generatedAtRef.current.delete(saved.id)
    }
    setRules(rulesRef.current)
    setRevision((value) => value + 1)
  }, [])

  const remove = useCallback(async (id: number) => {
    await customMixService.delete(id)
    rulesRef.current = rulesRef.current.filter((rule) => rule.id !== id)
    mixRequestVersionRef.current.set(id, (mixRequestVersionRef.current.get(id) ?? 0) + 1)
    setRules(rulesRef.current)
    setMixes((current) => current.filter((mix) => mix.key !== `custom:${id}`))
    generatedAtRef.current.delete(id)
    setRevision((value) => value + 1)
  }, [])

  const generate = useCallback((rule: CustomMixRule, reason: CustomMixGenerationReason) =>
    generateMix(rule, candidatesRef.current, reason), [generateMix])

  return { rules, candidates, mixes, error, save, remove, generate }
}
