import { useCallback, useEffect, useRef, useState } from 'react'
import type { HourMix } from '../../utils/hourMixes'
import type { CustomMixCandidate, CustomMixRule } from './types'
import { generateCustomMix } from './rules'
import { customMixService } from './service'

type OnlineResult = Awaited<ReturnType<typeof customMixService.augmentOnlineGenre>>

export function useCustomMixes(libraryVersion: number, editorOpen = false) {
  const [revision, setRevision] = useState(0)
  const [rules, setRules] = useState<CustomMixRule[]>([])
  const [candidates, setCandidates] = useState<CustomMixCandidate[]>([])
  const [mixes, setMixes] = useState<HourMix[]>([])
  const [error, setError] = useState('')
  const seed = useRef(Math.random())
  const onlinePending = useRef(new Map<string, Promise<OnlineResult>>())
  const onlineCache = useRef(
    new Map<
      string,
      {
        at: number
        value: OnlineResult
      }
    >(),
  )
  useEffect(() => {
    let cancelled = false
    void customMixService
      .list()
      .then(async (saved) => {
        if (cancelled) return
        const library =
          saved.length || editorOpen
            ? await customMixService.getCandidates()
            : []
        if (cancelled) return
        setRules(saved)
        setCandidates(library)
        setError('')
        const build = (
          rule: CustomMixRule,
          pool = library,
          warnings: string[] = [],
        ): HourMix => {
          const result = generateCustomMix(rule, pool, {
            limit: 24,
            seed: `${seed.current}:${rule.id}:${revision}`,
          })
          return {
            key: `custom:${rule.id}`,
            kind: 'custom',
            title: rule.name,
            description: '',
            tracks: result.tracks,
            rule,
            warnings: [...result.warnings, ...warnings],
          }
        }
        setMixes(saved.map((rule) => build(rule)))
        // A small queue bounds independent genre requests even with many saved rules.
        const pending = saved.filter((rule) =>
          rule.specials.includes('onlineGenre'),
        )
        let next = 0
        const worker = async () => {
          while (!cancelled && next < pending.length) {
            const rule = pending[next++]
            const key = `${JSON.stringify(rule)}:${revision}`
            const cached = onlineCache.current.get(key)
            let extra: OnlineResult
            if (cached && Date.now() - cached.at < 300_000) extra = cached.value
            else {
              let request = onlinePending.current.get(key)
              if (!request) {
                request = customMixService.augmentOnlineGenre(rule, library).finally(() => onlinePending.current.delete(key))
                onlinePending.current.set(key, request)
              }
              extra = await request
            }
            if (!cached || cached.value !== extra) {
              onlineCache.current.set(key, { at: Date.now(), value: extra })
              if (onlineCache.current.size > 30)
                onlineCache.current.delete(
                  onlineCache.current.keys().next().value!,
                )
            }
            if (cancelled) return
            const fresh = build(
              rule,
              [...library, ...extra.candidates],
              extra.warnings,
            )
            setMixes((current) =>
              current.map((mix) => (mix.key === fresh.key ? fresh : mix)),
            )
          }
        }
        await Promise.all([worker(), worker()])
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [libraryVersion, revision, editorOpen])
  const save = useCallback(async (rule: CustomMixRule) => {
    await customMixService.save(rule)
    setRevision((v) => v + 1)
  }, [])
  const remove = useCallback(async (id: number) => {
    await customMixService.delete(id)
    setRevision((v) => v + 1)
  }, [])
  return { rules, candidates, mixes, error, save, remove }
}
