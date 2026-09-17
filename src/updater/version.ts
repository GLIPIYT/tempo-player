/**
 * Version comparison for the updater.
 *
 * Deliberately not a semver dependency: this project only ever ships
 * `major.minor.patch`, and the one thing the updater has to get right is that
 * `0.10.0` is newer than `0.9.0` - which a string compare gets backwards.
 */

/**
 * Numeric parts of a version, with a leading `v` and any pre-release tag
 * dropped, so `v0.6.0` and `0.6.0-rc1` both read as `[0, 6, 0]`.
 */
export function parseVersion(value: string): number[] {
  const core = value.trim().replace(/^v/i, '').split('-')[0]
  return core.split('.').map((part) => {
    const n = Number.parseInt(part, 10)
    return Number.isFinite(n) ? n : 0
  })
}

/** -1 when `a` is older, 0 when they match, 1 when `a` is newer. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    // a missing part is zero, so `0.6` and `0.6.0` are the same version
    const x = left[i] ?? 0
    const y = right[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * Releases strictly newer than `current`, newest first.
 *
 * Strictly: the running version is not offered as an update to itself.
 */
export function newerThan<T extends { version: string }>(releases: T[], current: string): T[] {
  return releases
    .filter((release) => compareVersions(release.version, current) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))
}
