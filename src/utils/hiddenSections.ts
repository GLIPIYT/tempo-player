/**
 * Sections the user hid from the home page until tomorrow.
 *
 * Only the calendar day is stored, so a hidden section comes back on its own
 * the next day without any timer or migration: a hidden entry simply stops
 * matching once the date changes.
 */

import { useSyncExternalStore } from 'react'

const KEY = 'tempo.hiddenSections.v1'

type Stored = Record<string, string>

const listeners = new Set<() => void>()
let cache: Stored | null = null
let version = 0

/** Re-renders the caller whenever a section is hidden or restored. */
export function useHiddenSections(): void {
  useSyncExternalStore(
    subscribeHiddenSections,
    () => version,
    () => 0,
  )
}

function today(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function read(): Stored {
  if (cache) return cache
  try {
    const raw = window.localStorage.getItem(KEY)
    const parsed = raw ? (JSON.parse(raw) as Stored) : {}
    cache = parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    cache = {}
  }
  return cache
}

function write(next: Stored): void {
  cache = next
  version += 1
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* storage full or unavailable */
  }
  for (const l of listeners) l()
}

export function subscribeHiddenSections(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function isSectionHidden(id: string): boolean {
  return read()[id] === today()
}

export function hideSectionUntilTomorrow(id: string): void {
  write({ ...read(), [id]: today() })
}

export function unhideSection(id: string): void {
  const next = { ...read() }
  delete next[id]
  write(next)
}

export function anySectionHidden(): boolean {
  const day = today()
  return Object.values(read()).some((value) => value === day)
}

export function unhideAllSections(): void {
  const day = today()
  const next: Stored = {}
  for (const [k, v] of Object.entries(read())) {
    if (v !== day) next[k] = v
  }
  write(next)
}
