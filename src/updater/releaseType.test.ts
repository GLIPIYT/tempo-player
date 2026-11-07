import { expect, it } from 'vitest'
import { releaseType } from './releaseType'
import type { ReleaseInfo } from './service'
const release = (version: string, notes = ''): ReleaseInfo => ({ version, notes, tag: `v${version}`, name: '', publishedAt: '', assetName: null, assetUrl: null, assetSize: null })
it('uses explicit importance metadata and otherwise compares the previous published version', () => {
  const all = ['1.0.0', '1.1.0', '1.1.2', '2.0.0'].map(version => release(version))
  expect(releaseType(all[1], all)).toBe('average')
  expect(releaseType(all[2], all)).toBe('minor')
  expect(releaseType(all[3], all)).toBe('major')
  expect(releaseType(all[0], all)).toBe('major')
  expect(releaseType(release('1.1.2', '<!-- tempo:release-type=major -->'), all)).toBe('major')
})
