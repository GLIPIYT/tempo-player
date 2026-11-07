import type { ReleaseInfo } from './service'
import { compareVersions } from './version'

export type ReleaseType = 'minor' | 'average' | 'major'
export const RELEASE_TYPE_LABELS = { minor: 'Minor update', average: 'Feature update', major: 'Major update' } as const
export const RELEASE_TYPE_MARKER = /<!--\s*tempo:release-type\s*=\s*(minor|average|major)\s*-->/i

/** Explicit release-note metadata wins; older notes fall back to version changes. */
export function releaseType(release: ReleaseInfo, releases: readonly ReleaseInfo[]): ReleaseType | null {
  const explicit = RELEASE_TYPE_MARKER.exec(release.notes)?.[1]?.toLowerCase()
  if (explicit) return explicit as ReleaseType
  const previous = releases.filter(item => compareVersions(item.version, release.version) < 0)
    .sort((a, b) => compareVersions(b.version, a.version))[0]
  const parse = (version: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number)
  const next = parse(release.version), before = previous && parse(previous.version)
  if (!next) return null
  if (!before) return next[2] > 0 ? 'minor' : next[1] > 0 ? 'average' : 'major'
  return next[0] !== before[0] ? 'major' : next[1] !== before[1] ? 'average' : 'minor'
}
