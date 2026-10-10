// Inks (light, dark) for characters, names, and mentions.
export const INKS = {
  deepseek: ['#4D6BFE', '#6A84FF'], charcoal: ['#141416', '#F1F2F4'], graphite: ['#2D2D2D', '#D6D6DA'],
  rose: ['#EC2F6B', '#FF5A7A'], sky: ['#0AA8D6', '#2EE6E0'], tangerine: ['#FF6900', '#FF8A2E'],
  cobalt: ['#082DFF', '#5C78FF'],
  black: ['#000000', '#FFFFFF'], brown: ['#A27952', '#855C36'], red: ['#FF3E51', '#E02135'],
  orange: ['#FF781C', '#FF6700'], yellow: ['#FFAF38', '#FF9800'], green: ['#00C972', '#009957'],
  cyan: ['#1CC3B0', '#00A592'], blue: ['#2A92FE', '#0E74E0'], violet: ['#A97EFE', '#804EE0'],
  magenta: ['#FF5EB1', '#E02A88'], gray: ['#959595', '#777777'], aurora: ['#00B8D4', '#2EE6E0'],
}
// Gradient colors paint a character from its top left to its bottom right; their ink
// above is the text color. Aurora is the first star mascot's gradient.
export const GRADIENTS = { aurora: [[0, '#A4FFB0'], [0.42, '#00F0E4'], [1, '#2E9EF7']] }
export const ACCENT_INKS = ['deepseek', 'charcoal', 'graphite', 'rose', 'sky', 'tangerine', 'cobalt']
// Renamed ink ids still found in saved Bots and Bot-to-Bot replies (LEGACY: old id → new id).
const LEGACY_INKS = { kimi: 'charcoal', zai: 'graphite', minimax: 'rose', stepfun: 'sky', mimo: 'tangerine', qwen: 'cobalt' }
export const isHex = color => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)
export const luminance = hex => [1, 3, 5]
  .map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
  .map(channel => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
  .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
const inkName = color => (INKS[color] ? color : INKS[LEGACY_INKS[color]] ? LEGACY_INKS[color] : 'gray')
export const inkFill = color => (isHex(color) ? color : `var(--bt-ink-${inkName(color)})`)
// Text in a Bot's color; pure black reads as a heading, so it falls back to gray.
export const inkText = color => (color === 'black' ? 'var(--bt-ink-gray)' : inkFill(color))
// A color as a CSS background, for swatches and masked marks.
export const paintCss = color => (GRADIENTS[color] ? `linear-gradient(135deg,${GRADIENTS[color].map(([offset, value]) => `${value} ${offset * 100}%`).join(',')})` : inkFill(color))
