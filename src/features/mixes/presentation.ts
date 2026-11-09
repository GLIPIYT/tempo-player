import { useSyncExternalStore } from 'react'
import type { HourMix } from '../../utils/hourMixes'
import { customMixRuleFingerprint } from './snapshot'

const STORAGE_KEY = 'tempo.mixPresentation.v1'

export interface HiddenMixGeneration {
  generatedAt: number
  ruleFingerprint: string
}

export type HiddenMixGenerations = Readonly<Record<string, HiddenMixGeneration>>

export interface MixPresentationSnapshot {
  order: readonly string[]
  hiddenGenerations: HiddenMixGenerations
}

const EMPTY_SNAPSHOT: MixPresentationSnapshot = {
  order: [],
  hiddenGenerations: {},
}

let snapshot = EMPTY_SNAPSHOT
let loaded = false
const listeners = new Set<() => void>()

function uniqueKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>()
  return keys.filter((key) => {
    if (typeof key !== 'string' || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Sort known mixes by their saved keys; new mixes retain their input order at the end. */
export function applyMixOrder<T extends Pick<HourMix, 'key'>>(
  mixes: readonly T[],
  storedKeys: readonly string[],
): T[] {
  const rank = new Map<string, number>()
  uniqueKeys(storedKeys).forEach((key, index) => rank.set(key, index))
  return mixes
    .map((mix, index) => ({ mix, index, rank: rank.get(mix.key) }))
    .sort((left, right) => {
      if (left.rank == null && right.rank != null) return 1
      if (left.rank != null && right.rank == null) return -1
      if (left.rank != null && right.rank != null && left.rank !== right.rank) return left.rank - right.rank
      return left.index - right.index
    })
    .map(({ mix }) => mix)
}

/**
 * Replace the saved slots for currently visible mixes while leaving missing or
 * temporarily hidden mix keys in their existing slots.
 */
export function mergeMixOrder(
  previousKeys: readonly string[],
  visibleReorderedKeys: readonly string[],
): string[] {
  const previous = uniqueKeys(previousKeys)
  const visible = uniqueKeys(visibleReorderedKeys)
  const visibleSet = new Set(visible)
  let nextVisible = 0

  const merged = previous.map((key) => {
    if (!visibleSet.has(key)) return key
    return visible[nextVisible++]
  })

  while (nextVisible < visible.length) merged.push(visible[nextVisible++])
  return merged
}

function getStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function parseSnapshot(value: string | null): MixPresentationSnapshot {
  if (!value) return EMPTY_SNAPSHOT
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed == null || typeof parsed !== 'object') return EMPTY_SNAPSHOT
    const record = parsed as { order?: unknown; hiddenGenerations?: unknown }
    const order = Array.isArray(record.order)
      ? uniqueKeys(record.order.filter((key): key is string => typeof key === 'string'))
      : []
    const rawHidden = record.hiddenGenerations
    const hiddenGenerations: Record<string, HiddenMixGeneration> = {}
    if (rawHidden != null && typeof rawHidden === 'object' && !Array.isArray(rawHidden)) {
      for (const [key, token] of Object.entries(rawHidden)) {
        if (token == null || typeof token !== 'object') continue
        const candidate = token as Partial<HiddenMixGeneration>
        if (typeof candidate.generatedAt !== 'number' || !Number.isFinite(candidate.generatedAt)
          || typeof candidate.ruleFingerprint !== 'string') continue
        hiddenGenerations[key] = {
          generatedAt: candidate.generatedAt,
          ruleFingerprint: candidate.ruleFingerprint,
        }
      }
    }
    return { order, hiddenGenerations }
  } catch {
    return EMPTY_SNAPSHOT
  }
}

function loadSnapshot(): void {
  if (loaded) return
  loaded = true
  const storage = getStorage()
  if (!storage) return
  try {
    snapshot = parseSnapshot(storage.getItem(STORAGE_KEY))
  } catch {
    snapshot = EMPTY_SNAPSHOT
  }
}

function getSnapshot(): MixPresentationSnapshot {
  loadSnapshot()
  return snapshot
}

function notifyListeners(): void {
  listeners.forEach((listener) => listener())
}

function replaceSnapshot(next: MixPresentationSnapshot): void {
  snapshot = next
  loaded = true
  const storage = getStorage()
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Keep the current tab responsive when storage is unavailable or full.
    }
  }
  notifyListeners()
}

function handleStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== STORAGE_KEY) return
  const storage = getStorage()
  if (event.storageArea && storage && event.storageArea !== storage) return
  snapshot = event.key === null ? EMPTY_SNAPSHOT : parseSnapshot(event.newValue)
  loaded = true
  notifyListeners()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  loadSnapshot()
  if (listeners.size === 1 && typeof window !== 'undefined') {
    try {
      window.addEventListener('storage', handleStorage)
    } catch {
      // A missing browser event surface does not prevent local subscriptions.
    }
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== 'undefined') {
      try {
        window.removeEventListener('storage', handleStorage)
      } catch {
        // The store remains usable in constrained browser and test contexts.
      }
    }
  }
}

function getServerSnapshot(): MixPresentationSnapshot {
  return EMPTY_SNAPSHOT
}

/** Subscribe React components to saved mix order and custom-mix hide tokens. */
export function useMixPresentation(): MixPresentationSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

export function saveMixOrder(visibleKeys: readonly string[]): void {
  const current = getSnapshot()
  const order = mergeMixOrder(current.order, visibleKeys)
  if (order.length === current.order.length && order.every((key, index) => key === current.order[index])) return
  replaceSnapshot({ ...current, order })
}

function hiddenGenerationFor(mix: HourMix): HiddenMixGeneration | null {
  if (mix.kind !== 'custom' || !mix.rule || !(mix.rule.refreshIntervalMinutes > 0)) return null
  const generatedAt = mix.generatedAt
  if (typeof generatedAt !== 'number' || !Number.isFinite(generatedAt)) return null
  return { generatedAt, ruleFingerprint: customMixRuleFingerprint(mix.rule) }
}

/** Hide a positive-cadence custom mix until its snapshot or rule changes. */
export function hideMixUntilNextGeneration(mix: HourMix): void {
  const token = hiddenGenerationFor(mix)
  if (!token) return
  const current = getSnapshot()
  if (current.hiddenGenerations[mix.key]?.generatedAt === token.generatedAt
    && current.hiddenGenerations[mix.key]?.ruleFingerprint === token.ruleFingerprint) return
  replaceSnapshot({
    ...current,
    hiddenGenerations: { ...current.hiddenGenerations, [mix.key]: token },
  })
}

/** A cached fallback stays hidden; a new successful snapshot or edited rule is visible again. */
export function isMixGenerationHidden(
  mix: HourMix,
  hiddenGenerations: HiddenMixGenerations,
): boolean {
  const current = hiddenGenerationFor(mix)
  const hidden = hiddenGenerations[mix.key]
  return current != null && hidden != null
    && current.generatedAt === hidden.generatedAt
    && current.ruleFingerprint === hidden.ruleFingerprint
}
