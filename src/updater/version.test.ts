import { describe, expect, it } from 'vitest'
import {
  checkLatestVersionAvailability,
  checkReleaseAvailability,
  compareVersions,
  newerThan,
  parseVersion,
} from './version'

function release(version: string, assetUrl: string | null = `https://example.test/${version}.exe`) {
  return { version, assetUrl }
}

describe('parseVersion', () => {
  it('splits the dotted parts', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
  })

  it('drops a leading v and a pre-release tag', () => {
    expect(parseVersion('v0.6.0')).toEqual([0, 6, 0])
    expect(parseVersion('0.6.0-rc1')).toEqual([0, 6, 0])
  })

  it('turns anything unreadable into zero rather than NaN', () => {
    expect(parseVersion('')).toEqual([0])
    expect(parseVersion('nonsense')).toEqual([0])
  })
})

describe('compareVersions', () => {
  it('orders by number, not by string', () => {
    // the whole reason this module exists: as strings, "0.10.0" < "0.9.0"
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1)
  })

  it('reports equality', () => {
    expect(compareVersions('0.5.1', '0.5.1')).toBe(0)
    expect(compareVersions('v0.6.0', '0.6.0')).toBe(0)
    expect(compareVersions('0.6', '0.6.0')).toBe(0)
  })

  it('orders a patch above its minor', () => {
    expect(compareVersions('0.5.1', '0.6.0')).toBe(-1)
    expect(compareVersions('0.6.1', '0.6.0')).toBe(1)
  })

  it('does not crash on nonsense', () => {
    expect(compareVersions('', '0.0.1')).toBe(-1)
    expect(compareVersions('nonsense', 'nonsense')).toBe(0)
  })
})

describe('newerThan', () => {
  const releases = [
    { version: '0.4.0', tag: 'v0.4.0' },
    { version: '0.6.2', tag: 'v0.6.2' },
    { version: '0.6.0', tag: 'v0.6.0' },
    { version: '0.6.1', tag: 'v0.6.1' },
  ]

  it('keeps only what is strictly newer, newest first', () => {
    expect(newerThan(releases, '0.6.0').map((r) => r.version)).toEqual(['0.6.2', '0.6.1'])
  })

  it('leaves out the version that is already running', () => {
    expect(newerThan(releases, '0.6.2')).toEqual([])
  })

  it('offers everything when the running version is the oldest', () => {
    expect(newerThan(releases, '0.3.0').map((r) => r.version)).toEqual([
      '0.6.2',
      '0.6.1',
      '0.6.0',
      '0.4.0',
    ])
  })

  it('survives an empty list', () => {
    expect(newerThan([], '0.5.1')).toEqual([])
  })
})

describe('checkReleaseAvailability', () => {
  it('offers the newest release when its installer is available', () => {
    const result = checkReleaseAvailability(
      [release('1.9.0'), release('1.10.0'), release('1.8.0')],
      '1.9.0',
    )

    expect(result).toEqual({ status: 'update-available', latest: release('1.10.0') })
  })

  it('does not call a newer release up to date when its installer is missing', () => {
    const result = checkReleaseAvailability(
      [release('1.9.0'), release('1.10.0', null)],
      '1.9.0',
    )

    expect(result).toEqual({ status: 'installer-missing', latest: release('1.10.0', null) })
  })

  it('reports the newest release when the running version is current', () => {
    const result = checkReleaseAvailability([release('1.9.0'), release('1.10.0')], '1.10.0')

    expect(result).toEqual({ status: 'up-to-date', latest: release('1.10.0') })
  })

  it('distinguishes an empty release list from a current installation', () => {
    expect(checkReleaseAvailability([], '1.10.0')).toEqual({ status: 'no-releases', latest: null })
  })
})

describe('checkLatestVersionAvailability', () => {
  it('classifies the version-only latest response without needing release assets', () => {
    expect(checkLatestVersionAvailability('1.10.0', '1.9.0')).toEqual({
      status: 'update-available',
      latestVersion: '1.10.0',
    })
    expect(checkLatestVersionAvailability('1.9.0', '1.10.0')).toEqual({
      status: 'up-to-date',
      latestVersion: '1.9.0',
    })
  })

  it('reports an empty latest response distinctly', () => {
    expect(checkLatestVersionAvailability(null, '1.10.0')).toEqual({
      status: 'no-releases',
      latestVersion: null,
    })
  })
})
