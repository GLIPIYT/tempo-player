import type { RepeatMode, UnifiedTrack } from '../types/models'

function shuffleInto(target: UnifiedTrack[]): UnifiedTrack[] {
  const arr = target.slice()
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

export class QueueController {
  private base: UnifiedTrack[] = []
  private items: UnifiedTrack[] = []
  private index = -1
  private shuffled = false

  getItems(): UnifiedTrack[] {
    return this.items.slice()
  }

  getIndex(): number {
    return this.index
  }

  setQueue(items: UnifiedTrack[], startIndex = 0): void {
    this.base = items.slice()
    if (items.length === 0) {
      this.items = []
      this.index = -1
      return
    }
    if (this.shuffled) {
      const clamped = Math.min(Math.max(startIndex, 0), items.length - 1)
      const head = items[clamped]
      const rest = items.filter((_, i) => i !== clamped)
      this.items = [head, ...shuffleInto(rest)]
      this.index = 0
      return
    }
    this.items = items.slice()
    this.index = Math.min(Math.max(startIndex, 0), items.length - 1)
  }

  current(): UnifiedTrack | null {
    if (this.index < 0 || this.index >= this.items.length) return null
    return this.items[this.index]
  }

  next(repeat: RepeatMode): UnifiedTrack | null {
    if (this.items.length === 0) return null
    if (this.index < this.items.length - 1) {
      this.index += 1
      return this.items[this.index]
    }
    if (repeat === 'all') {
      this.index = 0
      return this.items[0]
    }
    return null
  }

  previous(repeat: RepeatMode): UnifiedTrack | null {
    if (this.items.length === 0) return null
    if (this.index > 0) {
      this.index -= 1
      return this.items[this.index]
    }
    if (repeat === 'all') {
      this.index = this.items.length - 1
      return this.items[this.index]
    }
    return null
  }

  peekNext(repeat: RepeatMode): UnifiedTrack | null {
    if (this.items.length === 0) return null
    if (this.index < this.items.length - 1) return this.items[this.index + 1]
    if (repeat === 'all') return this.items[0]
    return null
  }

  addToNext(t: UnifiedTrack): void {
    if (this.items.length === 0) {
      this.base.push(t)
      this.items.push(t)
      this.index = 0
      return
    }
    const cur = this.items[this.index] ?? null
    this.items.splice(this.index + 1, 0, t)
    const basePos = cur ? this.base.indexOf(cur) : -1
    if (basePos >= 0) this.base.splice(basePos + 1, 0, t)
    else this.base.push(t)
  }

  append(t: UnifiedTrack): void {
    this.base.push(t)
    this.items.push(t)
    if (this.index === -1) this.index = 0
  }

  move(from: number, to: number): void {
    const len = this.items.length
    if (from < 0 || from >= len || to < 0 || to >= len || from === to) return
    const moved = this.items[from]
    const wasCurrent = from === this.index
    this.items.splice(from, 1)
    this.items.splice(to, 0, moved)
    const basePos = this.base.indexOf(moved)
    if (basePos !== -1) {
      this.base.splice(basePos, 1)
      const pred = to > 0 ? this.items[to - 1] : null
      if (pred) {
        const predBase = this.base.indexOf(pred)
        if (predBase !== -1) this.base.splice(predBase + 1, 0, moved)
        else this.base.push(moved)
      } else {
        const succ = this.items[to + 1] ?? null
        const succBase = succ ? this.base.indexOf(succ) : -1
        if (succBase !== -1) this.base.splice(succBase, 0, moved)
        else this.base.push(moved)
      }
    }
    if (wasCurrent) {
      this.index = this.items.indexOf(moved)
    } else if (from < this.index && to >= this.index) {
      this.index -= 1
    } else if (from > this.index && to <= this.index) {
      this.index += 1
    }
  }

  removeAt(i: number): void {
    if (i < 0 || i >= this.items.length) return
    const removed = this.items[i]
    this.items.splice(i, 1)
    const basePos = this.base.indexOf(removed)
    if (basePos !== -1) this.base.splice(basePos, 1)
    if (i < this.index) {
      this.index -= 1
    } else if (i === this.index && this.index >= this.items.length) {
      this.index = this.items.length - 1
    }
    if (this.items.length === 0) this.index = -1
  }

  clear(): void {
    this.base = []
    this.items = []
    this.index = -1
  }

  setShuffled(on: boolean): void {
    if (on === this.shuffled) return
    this.shuffled = on
    if (this.items.length <= 1) return
    if (on) {
      const cur = this.current()
      const rest = this.items.filter((_, i) => i !== this.index)
      this.items = cur ? [cur, ...shuffleInto(rest)] : shuffleInto(rest)
      this.index = cur ? 0 : this.items.length > 0 ? 0 : -1
      return
    }
    const cur = this.current()
    this.items = this.base.slice()
    const restored = cur ? this.items.indexOf(cur) : -1
    this.index = restored !== -1 ? restored : Math.min(this.index, this.items.length - 1)
  }

  isShuffled(): boolean {
    return this.shuffled
  }
}
