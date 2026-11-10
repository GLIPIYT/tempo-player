export interface BackgroundRgb { r: number; g: number; b: number }

/** Keep the background's hue; neutral white/grey backgrounds stay neutral. */
export function contrastBackgroundColor(background: BackgroundRgb): BackgroundRgb {
  const linear = (channel: number) => {
    const value = Math.max(0, Math.min(255, channel)) / 255
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
  }
  const luminance = .2126 * linear(background.r) + .7152 * linear(background.g) + .0722 * linear(background.b)
  const dark = luminance < .43
  const amount = dark ? .28 : .22
  const target = dark ? 255 : 0
  const shift = (value: number) => Math.round(Math.max(0, Math.min(255, value)) * (1 - amount) + target * amount)
  return { r: shift(background.r), g: shift(background.g), b: shift(background.b) }
}
