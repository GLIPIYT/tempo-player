import { useCallback, useEffect, useRef, useState } from 'react'
import type { AsyncState } from '../../hooks/useAsync'

interface HomeDataEntry {
  version: number
  data: unknown
}

const MAX_HOME_CACHE_ENTRIES = 32

export interface HomeDataCache {
  peek<T>(key: string): HomeDataEntry & { data: T } | undefined
  load<T>(key: string, version: number, loader: () => Promise<T>): Promise<T>
}

/** Create a process-local result cache with per-key/version request deduplication. */
export function createHomeDataCache(): HomeDataCache {
  const values = new Map<string, HomeDataEntry>()
  const pending = new Map<string, Promise<unknown>>()
  const remember = (key: string, entry: HomeDataEntry) => {
    values.delete(key)
    values.set(key, entry)
    while (values.size > MAX_HOME_CACHE_ENTRIES) {
      const oldestKey = values.keys().next().value as string | undefined
      if (oldestKey == null) break
      values.delete(oldestKey)
    }
  }

  return {
    peek<T>(key: string): (HomeDataEntry & { data: T }) | undefined {
      const entry = values.get(key)
      if (entry) {
        values.delete(key)
        values.set(key, entry)
      }
      return entry as (HomeDataEntry & { data: T }) | undefined
    },
    load<T>(key: string, version: number, loader: () => Promise<T>): Promise<T> {
      const requestKey = JSON.stringify([key, version])
      const existing = pending.get(requestKey)
      if (existing) return existing as Promise<T>

      const request: Promise<T> = Promise.resolve()
        .then(loader)
        .then<T>((data) => {
          const current = values.get(key)
          if (!current || version >= current.version) remember(key, { version, data })
          return data
        })
        .finally(() => {
          if (pending.get(requestKey) === request) pending.delete(requestKey)
        })
      pending.set(requestKey, request)
      return request
    },
  }
}

export const homeDataCache = createHomeDataCache()

interface HomeDataState<T> {
  identity: string | null
  key: string | null
  data: T | null
  loading: boolean
  error: string | null
}

/**
 * Return the last Home result on the first render, then refresh it for the
 * current library version. Both values and in-flight work live only in memory.
 */
export function useHomeData<T>(
  key: string,
  loader: () => Promise<T>,
  version: number,
): AsyncState<T> {
  const [tick, setTick] = useState(0)
  const identity = JSON.stringify([key, version, tick])
  const [state, setState] = useState<HomeDataState<T>>(() => ({
    identity: null,
    key: null,
    data: homeDataCache.peek<T>(key)?.data ?? null,
    loading: true,
    error: null,
  }))
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  useEffect(() => {
    let cancelled = false
    const cached = homeDataCache.peek<T>(key)
    setState({ identity, key, data: cached?.data ?? null, loading: true, error: null })
    void homeDataCache.load(key, version, () => loaderRef.current())
      .then((data) => {
        if (cancelled) return
        setState({ identity, key, data, loading: false, error: null })
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        const current = homeDataCache.peek<T>(key)
        setState((previous) => ({
          identity,
          key,
          data: current?.data ?? (previous.key === key ? previous.data : null),
          loading: false,
          error: cause instanceof Error ? cause.message : String(cause),
        }))
      })
    return () => { cancelled = true }
  }, [identity, key, version])

  const reload = useCallback(() => setTick((value) => value + 1), [])
  const isCurrent = state.identity === identity
  const data = isCurrent ? state.data : homeDataCache.peek<T>(key)?.data ?? null
  return {
    data,
    loading: !isCurrent || state.loading,
    error: isCurrent ? state.error : null,
    reload,
  }
}
