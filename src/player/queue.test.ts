import { describe, expect, it } from 'vitest'
import { QueueController } from './queue'
import type { UnifiedTrack } from '../types/models'

function track(id: string): UnifiedTrack {
  return {
    source: 'local',
    sourceId: id,
    dbId: null,
    title: id,
    artists: [],
    album: null,
    durationSec: 100,
    coverPath: null,
    playable: true,
    localPath: null,
    externalUrl: null,
    gainDb: null,
  }
}

function queueOf(order: string[], startIndex = 0): QueueController {
  const queue = new QueueController()
  queue.setQueue(order.map(track), startIndex)
  return queue
}

function ids(queue: QueueController): string[] {
  return queue.getItems().map((t) => t.sourceId)
}

function currentId(queue: QueueController): string | null {
  return queue.current()?.sourceId ?? null
}

describe('setQueue', () => {
  it('starts on the requested track', () => {
    const queue = queueOf(['a', 'b', 'c'], 1)
    expect(currentId(queue)).toBe('b')
    expect(queue.getIndex()).toBe(1)
  })

  it('clamps a start index past either end', () => {
    expect(currentId(queueOf(['a', 'b', 'c'], 99))).toBe('c')
    expect(currentId(queueOf(['a', 'b', 'c'], -5))).toBe('a')
  })

  it('leaves an empty queue with nothing playing', () => {
    const queue = queueOf([])
    expect(queue.current()).toBeNull()
    expect(queue.getIndex()).toBe(-1)
  })
})

describe('next and previous', () => {
  it('walks forward and back', () => {
    const queue = queueOf(['a', 'b', 'c'], 0)
    expect(queue.next('off')?.sourceId).toBe('b')
    expect(queue.next('off')?.sourceId).toBe('c')
    expect(queue.previous('off')?.sourceId).toBe('b')
  })

  it('stops at the ends when repeat is off', () => {
    const queue = queueOf(['a', 'b'], 1)
    expect(queue.next('off')).toBeNull()
    expect(queue.previous('off')?.sourceId).toBe('a')
    expect(queue.previous('off')).toBeNull()
  })

  it('wraps at both ends when repeat is all', () => {
    const queue = queueOf(['a', 'b'], 1)
    expect(queue.next('all')?.sourceId).toBe('a')
    expect(queue.previous('all')?.sourceId).toBe('b')
  })

  it('does not wrap on its own when repeat is one - the engine replays instead', () => {
    const queue = queueOf(['a', 'b'], 1)
    expect(queue.next('one')).toBeNull()
    expect(queue.previous('one')?.sourceId).toBe('a')
  })

  it('has nothing to give from an empty queue', () => {
    const queue = queueOf([])
    expect(queue.next('all')).toBeNull()
    expect(queue.previous('all')).toBeNull()
    expect(queue.peekNext('all')).toBeNull()
  })
})

describe('peekNext', () => {
  it('reports the next track without moving', () => {
    const queue = queueOf(['a', 'b', 'c'], 0)
    expect(queue.peekNext('off')?.sourceId).toBe('b')
    expect(queue.getIndex()).toBe(0)
  })

  it('knows about the wrap that repeat all would take', () => {
    const queue = queueOf(['a', 'b'], 1)
    expect(queue.peekNext('off')).toBeNull()
    expect(queue.peekNext('all')?.sourceId).toBe('a')
  })
})

describe('shuffle', () => {
  it('keeps the playing track and puts it first', () => {
    const queue = queueOf(['a', 'b', 'c', 'd', 'e'], 2)
    queue.setShuffled(true)
    expect(currentId(queue)).toBe('c')
    expect(queue.getIndex()).toBe(0)
    expect(ids(queue)[0]).toBe('c')
  })

  it('keeps every track exactly once', () => {
    const queue = queueOf(['a', 'b', 'c', 'd', 'e'], 2)
    queue.setShuffled(true)
    expect([...ids(queue)].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('restores the original order and the playing track when switched back off', () => {
    const queue = queueOf(['a', 'b', 'c', 'd', 'e'], 2)
    queue.setShuffled(true)
    queue.setShuffled(false)
    expect(ids(queue)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(currentId(queue)).toBe('c')
    expect(queue.getIndex()).toBe(2)
  })

  it('survives a queue too small to shuffle', () => {
    const queue = queueOf(['a'], 0)
    queue.setShuffled(true)
    expect(ids(queue)).toEqual(['a'])
    expect(currentId(queue)).toBe('a')
  })

  it('is a no-op when nothing changes', () => {
    const queue = queueOf(['a', 'b'], 0)
    queue.setShuffled(false)
    expect(ids(queue)).toEqual(['a', 'b'])
    expect(queue.isShuffled()).toBe(false)
  })
})

describe('move', () => {
  it('keeps the index on the current track when that is the one moved', () => {
    const queue = queueOf(['a', 'b', 'c', 'd', 'e'], 2)
    queue.move(2, 4)
    expect(ids(queue)).toEqual(['a', 'b', 'd', 'e', 'c'])
    expect(queue.getIndex()).toBe(4)
    expect(currentId(queue)).toBe('c')
  })

  it('shifts the index down when a track moves from before it to after it', () => {
    const queue = queueOf(['a', 'b', 'c', 'd', 'e'], 2)
    queue.move(0, 4)
    expect(ids(queue)).toEqual(['b', 'c', 'd', 'e', 'a'])
    expect(queue.getIndex()).toBe(1)
    expect(currentId(queue)).toBe('c')
  })

  it('shifts the index up when a track moves from after it to before it', () => {
    const queue = queueOf(['a', 'b', 'c', 'd', 'e'], 1)
    queue.move(4, 0)
    expect(ids(queue)).toEqual(['e', 'a', 'b', 'c', 'd'])
    expect(queue.getIndex()).toBe(2)
    expect(currentId(queue)).toBe('b')
  })

  it('ignores a move that would not change anything', () => {
    const queue = queueOf(['a', 'b', 'c'], 1)
    queue.move(1, 1)
    queue.move(-1, 2)
    queue.move(0, 99)
    expect(ids(queue)).toEqual(['a', 'b', 'c'])
    expect(queue.getIndex()).toBe(1)
  })
})

describe('removeAt', () => {
  it('shifts the index down when something before the current track goes', () => {
    const queue = queueOf(['a', 'b', 'c', 'd', 'e'], 2)
    queue.removeAt(0)
    expect(ids(queue)).toEqual(['b', 'c', 'd', 'e'])
    expect(queue.getIndex()).toBe(1)
    expect(currentId(queue)).toBe('c')
  })

  it('leaves the index alone when something after the current track goes', () => {
    const queue = queueOf(['a', 'b', 'c', 'd', 'e'], 2)
    queue.removeAt(4)
    expect(ids(queue)).toEqual(['a', 'b', 'c', 'd'])
    expect(currentId(queue)).toBe('c')
  })

  it('falls back to the previous track when the current one is removed at the end', () => {
    const queue = queueOf(['a', 'b', 'c'], 2)
    queue.removeAt(2)
    expect(currentId(queue)).toBe('b')
  })

  it('ends up with nothing playing once the last track goes', () => {
    const queue = queueOf(['a'], 0)
    queue.removeAt(0)
    expect(queue.current()).toBeNull()
    expect(queue.getIndex()).toBe(-1)
  })

  it('ignores an out-of-range index', () => {
    const queue = queueOf(['a', 'b'], 0)
    queue.removeAt(5)
    queue.removeAt(-1)
    expect(ids(queue)).toEqual(['a', 'b'])
  })
})

describe('adding', () => {
  it('puts a play-next request right after the current track', () => {
    const queue = queueOf(['a', 'b', 'c'], 1)
    queue.addToNext(track('x'))
    expect(ids(queue)).toEqual(['a', 'b', 'x', 'c'])
    expect(currentId(queue)).toBe('b')
  })

  it('starts playing when the queue was empty', () => {
    const queue = queueOf([])
    queue.addToNext(track('x'))
    expect(currentId(queue)).toBe('x')
  })

  it('appends to the end without disturbing the index', () => {
    const queue = queueOf(['a', 'b'], 0)
    queue.append(track('c'))
    expect(ids(queue)).toEqual(['a', 'b', 'c'])
    expect(queue.getIndex()).toBe(0)
  })

  it('points at the last item on request', () => {
    const queue = queueOf(['a', 'b', 'c'], 0)
    queue.goToLast()
    expect(currentId(queue)).toBe('c')
  })
})

describe('clear', () => {
  it('leaves nothing behind', () => {
    const queue = queueOf(['a', 'b'], 1)
    queue.clear()
    expect(ids(queue)).toEqual([])
    expect(queue.current()).toBeNull()
  })
})
