import { useCallback, useEffect, useRef, useState } from 'react'
import type { HourMix } from '../../utils/hourMixes'
import type { CustomMixCandidate, CustomMixGenerationReason, CustomMixRule } from './types'
import { customMixService } from './service'
import { customMixRuleFingerprint } from './snapshot'

const OVERDUE_RETRY_MS = 60_000
const MAX_PARALLEL_GENERATIONS = 2
let activeGenerations = 0
const generationWaiters: Array<() => void> = []

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

export function useCustomMixes(libraryVersion: number, editorOpen = false) {
  const [revision, setRevision] = useState(0)
  const [rules, setRules] = useState<CustomMixRule[]>([])
  const [candidates, setCandidates] = useState<CustomMixCandidate[]>([])
  const [mixes, setMixes] = useState<HourMix[]>([])
  const [error, setError] = useState('')
  const rulesRef = useRef<CustomMixRule[]>([])
  const candidatesRef = useRef<CustomMixCandidate[]>([])
  const generatedAtRef = useRef(new Map<number, number>())
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
    const isCurrent = () => mountedRef.current && isActive() && rule.id != null
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
      void Promise.all(dueRules.map((rule) => generateMix(rule, candidatesRef.current, 'scheduled')))
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
    let cancelled = false
    void customMixService.list()
      .then(async (saved) => {
        const library = saved.length ? await customMixService.getCandidates() : candidatesRef.current
        if (cancelled) return
        rulesRef.current = saved
        candidatesRef.current = library
        setRules(saved)
        setCandidates(library)
        setMixes((current) => current.filter((mix) => saved.some((rule) => mix.key === `custom:${rule.id}`)))
        setError('')
        const reason: CustomMixGenerationReason = firstLoadRef.current ? 'open' : 'scheduled'
        firstLoadRef.current = false
        let next = 0
        const worker = async () => {
          while (!cancelled && next < saved.length) {
            const rule = saved[next++]
            await generateMix(rule, library, reason, () => !cancelled)
          }
        }
        await Promise.all([worker(), worker()])
        if (cancelled) return
        scheduleTimerRef.current()
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause))
        cancelled = true
      })
    return () => {
      cancelled = true
    }
  }, [libraryVersion, revision, generateMix])

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
    setRules(rulesRef.current)
    setRevision((value) => value + 1)
  }, [])

  const remove = useCallback(async (id: number) => {
    await customMixService.delete(id)
    rulesRef.current = rulesRef.current.filter((rule) => rule.id !== id)
    setRules(rulesRef.current)
    setMixes((current) => current.filter((mix) => mix.key !== `custom:${id}`))
    generatedAtRef.current.delete(id)
    setRevision((value) => value + 1)
  }, [])

  const generate = useCallback((rule: CustomMixRule, reason: CustomMixGenerationReason) =>
    generateMix(rule, candidatesRef.current, reason), [generateMix])

  return { rules, candidates, mixes, error, save, remove, generate }
}
