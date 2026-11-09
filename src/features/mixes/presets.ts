import type { HourMix } from '../../utils/hourMixes'
import { createCustomMixRule } from './types'

/** Copy editable criteria, never freeze the current track IDs into a rule. */
export function presetFromMix(mix: HourMix) {
  if (mix.rule) return structuredClone(mix.rule)
  const rule = createCustomMixRule(mix.title)
  if (mix.kind === 'hour') rule.specials = ['currentHour']
  if (mix.kind === 'artist')
    rule.artistIds = [
      ...new Set(
        mix.tracks.flatMap((t) => (t.artistId == null ? [] : [t.artistId])),
      ),
    ]
  if (mix.key === 'smart:forgotten-favorites') {
    rule.specials = ['forgotten']
    rule.forgottenPercent = [100, 100]
    rule.forgottenDays = [30, 365]
  }
  if (mix.key === 'smart:no-skips') rule.specials = ['noSkips']
  if (mix.key === 'smart:on-repeat') rule.specials = ['onRepeat']
  if (mix.key === 'smart:new-to-you') rule.specials = ['newToYou']
  return rule
}
