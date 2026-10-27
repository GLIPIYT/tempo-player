import { describe, expect, it } from 'vitest'
import { lyricsOverlayMode, manualLyricsSearchReducer, manualLyricsTrackIdentity, type ManualLyricsSearchState } from './lyricsOverlayState'

describe('lyrics overlay state', () => {
  it('keeps the empty screen loading while the shared lyrics request is pending', () => {
    expect(lyricsOverlayMode({
      activeResult: null,
      candidatesLoading: false,
      sharedRequestLoading: true,
      manualSearchLoading: false,
      candidateCount: 0,
    })).toBe('loading')
  })

  it('keeps the search form pending while its manual request is in flight', () => {
    expect(lyricsOverlayMode({
      activeResult: null,
      candidatesLoading: false,
      sharedRequestLoading: false,
      manualSearchLoading: true,
      candidateCount: 0,
    })).toBe('loading')
  })

  it('shows no lyrics only after candidate and shared requests have settled', () => {
    expect(lyricsOverlayMode({
      activeResult: null,
      candidatesLoading: false,
      sharedRequestLoading: false,
      manualSearchLoading: false,
      candidateCount: 0,
    })).toBe('empty')
  })

  it('shows a late plain result instead of an empty or loading state', () => {
    expect(lyricsOverlayMode({
      activeResult: { kind: 'plain', text: 'Fetched lyrics' },
      candidatesLoading: false,
      sharedRequestLoading: true,
      manualSearchLoading: true,
      candidateCount: 0,
    })).toBe('plain')
  })

  it('preserves typed search fields across same-track snapshots', () => {
    const state: ManualLyricsSearchState = {
      trackIdentity: 'local|42',
      artist: 'Typed artist',
      title: 'Typed title',
      visible: true,
    }

    expect(manualLyricsSearchReducer(state, {
      type: 'trackChanged',
      trackIdentity: state.trackIdentity,
      artist: 'Updated metadata artist',
      title: 'Updated metadata title',
    })).toBe(state)
  })

  it('keeps the initially visible empty-state form open after typing and a late result', () => {
    const initial: ManualLyricsSearchState = {
      trackIdentity: 'local|42',
      artist: 'Original artist',
      title: 'Original title',
      visible: false,
    }
    const typed = manualLyricsSearchReducer(initial, { type: 'artistChanged', value: 'Typed artist' })
    const afterLateResult = manualLyricsSearchReducer(typed, {
      type: 'trackChanged',
      trackIdentity: initial.trackIdentity,
      artist: 'Updated metadata artist',
      title: 'Updated metadata title',
    })

    expect(afterLateResult).toMatchObject({
      artist: 'Typed artist',
      title: 'Original title',
      visible: true,
    })
  })

  it('resets fields and closes the manual form when the track identity changes', () => {
    const state: ManualLyricsSearchState = {
      trackIdentity: 'local|42',
      artist: 'Typed artist',
      title: 'Typed title',
      visible: true,
    }

    expect(manualLyricsSearchReducer(state, {
      type: 'trackChanged',
      trackIdentity: 'local|43',
      artist: 'Next artist',
      title: 'Next title',
    })).toEqual({
      trackIdentity: 'local|43',
      artist: 'Next artist',
      title: 'Next title',
      visible: false,
    })
  })

  it('uses source and source ID as the manual-search identity', () => {
    const original = { source: 'local' as const, sourceId: '42', title: 'Original title', artists: ['Original artist'] }
    const updatedMetadata = { ...original, title: 'Updated title', artists: ['Updated artist'] }

    expect(manualLyricsTrackIdentity(original)).toBe(manualLyricsTrackIdentity(updatedMetadata))
    expect(manualLyricsTrackIdentity({ source: 'soundcloud', sourceId: 'sc-42' })).not.toBe(manualLyricsTrackIdentity(original))
  })
})
