import { describe, expect, it } from 'vitest'
import { playlistDisplayName } from './playlists'
import type { Playlist } from '../types/models'

function playlist(overrides: Partial<Playlist> = {}): Playlist {
  return { id: 1, name: 'Road trip', createdAt: 0, updatedAt: 0, ...overrides }
}

/** Stands in for the i18n lookup, which hands back the key when it has no entry. */
const t = (key: string): string => ({ Likes: 'Избранное' })[key as 'Likes'] ?? key

describe('playlistDisplayName', () => {
  it('falls back when there is no playlist at all', () => {
    expect(playlistDisplayName(null, 'Queue', t)).toBe('Queue')
    expect(playlistDisplayName(undefined, 'Queue', t)).toBe('Queue')
  })

  it('localises the auto-created Likes playlist', () => {
    expect(playlistDisplayName(playlist({ name: 'Likes', isLikes: true }), 'Queue', t)).toBe('Избранное')
  })

  it('leaves a renamed Likes playlist alone, because the user chose that name', () => {
    expect(playlistDisplayName(playlist({ name: 'Фавориты', isLikes: true }), 'Queue', t)).toBe('Фавориты')
  })

  it('leaves an ordinary playlist alone even when it happens to be called Likes', () => {
    expect(playlistDisplayName(playlist({ name: 'Likes' }), 'Queue', t)).toBe('Likes')
  })
})
