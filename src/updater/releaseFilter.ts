import type { ReleaseInfo } from './service'
import { releaseType, type ReleaseType } from './releaseType'

export type ReleaseTypeFilter = 'all' | ReleaseType

export function filterReleasesByType(choices: readonly ReleaseInfo[], releases: readonly ReleaseInfo[], filter: ReleaseTypeFilter): ReleaseInfo[] {
  return filter === 'all' ? [...choices] : choices.filter(release => releaseType(release, releases) === filter)
}
