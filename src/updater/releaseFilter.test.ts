import { expect, it } from 'vitest'
import { filterReleasesByType } from './releaseFilter'
import type { ReleaseInfo } from './service'

const release = (version: string, notes = ''): ReleaseInfo => ({ version, notes, tag: `v${version}`, name: '', publishedAt: '', assetName: null, assetUrl: null, assetSize: null })

it('filters using release metadata and the full release history', () => {
  const history = [release('1.0.0'), release('1.1.0'), release('1.1.1', '<!-- tempo:release-type=bugfix -->'), release('bad')]
  const choices = history.slice(1)
  expect(filterReleasesByType(choices, history, 'all')).toEqual(choices)
  expect(filterReleasesByType(choices, history, 'average')).toEqual([history[1]])
  expect(filterReleasesByType(choices, history, 'bugfix')).toEqual([history[2]])
  expect(filterReleasesByType(choices, history, 'major')).toEqual([])
})
