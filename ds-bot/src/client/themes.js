import { isHex, luminance } from './inks.js'
import { SHAPES, markupCache, maskCache } from './characters.js'
import { createSource } from './sources.js'

// -------------------------------------------------------------------------
// Themes. A theme names eight colors per mode; every `--bt-*` variable and the shell
// tokens derive from them, so a registered theme recolors the whole team UI.

const THEME_KEYS = ['bg', 'sidebar', 'bubble', 'card', 'text', 'user', 'userText', 'accent']
const THEMES = {
  deepseek: {
    label: 'DeepSeek',
    light: { bg: '#fcfcfc', sidebar: '#f7f7f7', bubble: '#eeeeee', card: '#ffffff', text: '#141414', user: '#070707', userText: '#fcfcfc', accent: '#4d6bfe' },
    dark: { bg: '#141414', sidebar: '#1b1b1b', bubble: '#262626', card: '#1f1f1f', text: '#f2f2f2', user: '#f2f2f2', userText: '#141414', accent: '#5b7bff' },
  },
  mono: {
    label: 'Mono',
    light: { bg: '#ffffff', sidebar: '#f9f9f9', bubble: '#f0f0f0', card: '#ffffff', text: '#0d0d0d', user: '#0d0d0d', userText: '#ffffff', accent: '#0d0d0d' },
    dark: { bg: '#0f0f0f', sidebar: '#171717', bubble: '#242424', card: '#1c1c1c', text: '#f4f4f4', user: '#f4f4f4', userText: '#0f0f0f', accent: '#f4f4f4' },
  },
  paper: {
    label: 'Paper',
    light: { bg: '#faf9f5', sidebar: '#f3f0e8', bubble: '#ebe7dc', card: '#ffffff', text: '#1f1e1b', user: '#2b2a26', userText: '#faf9f5', accent: '#d97757' },
    dark: { bg: '#1f1e1b', sidebar: '#262521', bubble: '#34322d', card: '#2a2925', text: '#f3f0e8', user: '#f3f0e8', userText: '#1f1e1b', accent: '#e08a6d' },
  },
  moonlight: {
    label: 'Moonlight',
    light: { bg: '#f7f9fc', sidebar: '#eef2f8', bubble: '#e5ebf5', card: '#ffffff', text: '#121826', user: '#1e3a8a', userText: '#ffffff', accent: '#1e86ff' },
    dark: { bg: '#0b1020', sidebar: '#10172a', bubble: '#1a2340', card: '#141c33', text: '#e8edf7', user: '#3b6fd8', userText: '#ffffff', accent: '#4f9dff' },
  },
}
const rgba = (hex, alpha) => `rgba(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(',')},${alpha})`
function themeVars(mode, dark, accent = mode.accent) {
  return {
    '--bt-ink': mode.text, '--bt-ink-2': rgba(mode.text, 0.6), '--bt-ink-3': rgba(mode.text, 0.36),
    '--bt-bubble': mode.bubble, '--bt-sidebar': mode.sidebar, '--bt-main': mode.bg, '--bt-card': mode.card,
    '--bt-line': rgba(mode.text, 0.08), '--bt-line-2': rgba(mode.text, 0.15),
    '--bt-hover': dark ? 'rgba(160,160,160,.12)' : 'rgba(119,119,119,.09)',
    '--bt-active': dark ? 'rgba(160,160,160,.2)' : 'rgba(119,119,119,.17)',
    '--bt-accent': accent, '--bt-accent-ink': luminance(accent) > 0.45 ? '#141414' : '#ffffff',
    '--bt-user': mode.user, '--bt-user-ink': mode.userText,
    '--bt-tag-bg': rgba(mode.text, dark ? 0.09 : 0.06), '--bt-tag-ink': rgba(mode.text, 0.58),
  }
}
const declarations = vars => Object.entries(vars).map(([name, value]) => `${name}:${value}`).join(';')
// `html body` outranks the base sheet's `body` rules without !important.
export const themeCss = (theme, accent) => `html body{${declarations(themeVars(theme.light, false, accent ?? theme.light.accent))}}
html body[data-ds-dark-theme]{${declarations(themeVars(theme.dark, true, accent ?? theme.dark.accent))}}
${theme.css ?? ''}`
export const shellTokens = ({ light, dark }) => ({
  '--dsw-alias-bg-base': { light: light.bg, dark: dark.bg },
  '--dsw-specific-sidebar-fill': { light: light.sidebar, dark: dark.sidebar },
  '--dsw-specific-input-major': { light: light.bg, dark: dark.sidebar },
  '--dsw-alias-label-primary': { light: light.text, dark: dark.text },
  '--dsw-alias-label-secondary': { light: rgba(light.text, 0.74), dark: rgba(dark.text, 0.74) },
  '--dsw-alias-label-tertiary': { light: rgba(light.text, 0.6), dark: rgba(dark.text, 0.6) },
})
// The user bubble belongs to the conversation group: on a plain Session the shell
// stays mounted but dsh's own colors paint the bubbles.
export const conversationTokens = ({ light, dark }) => ({
  '--dsw-specific-bubble': { light: light.user, dark: dark.user },
})

// Other plugins add character shapes and themes through `window.dshBot`, or queue
// calls on `window.dshBotQueue` before this plugin loads. A shape draws only its
// body; the eyes are cut out where `eyes.at` says, so it gets every state motion free.
const customThemes = {}
export const registry = createSource(0)
const isPoint = point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
export function registerShape(id, shape) {
  if (typeof id !== 'string' || !/^[a-z][\w-]{0,31}$/.test(id)) throw new Error('Shape ids are lowercase words')
  if (typeof shape?.body !== 'function' || typeof shape.body('#000') !== 'string') throw new Error('A shape needs body(paint) returning SVG markup')
  const at = shape.eyes?.at
  if (!Array.isArray(at) || at.length !== 2 || !at.every(isPoint)) throw new Error('A shape needs eyes.at: two [x, y] points')
  const size = Number.isFinite(shape.size) && shape.size > 0 ? shape.size : 100
  const pick = (key, fallback) => (Number.isFinite(shape.eyes[key]) ? shape.eyes[key] : fallback)
  const eyes = at.map(([x, y]) => [x, y, pick('w', size * 0.1), pick('h', size * 0.23), pick('tilt', -27)])
  const previous = SHAPES[id]
  SHAPES[id] = {
    label: String(shape.label ?? id),
    size,
    body: shape.body,
    eyes,
    ...(typeof shape.wrap === 'string' ? { wrap: shape.wrap } : {}),
  }
  const refresh = () => {
    markupCache.clear()
    maskCache.delete(id)
    registry.set(value => value + 1)
  }
  refresh()
  return () => {
    if (previous) SHAPES[id] = previous
    else delete SHAPES[id]
    refresh()
  }
}
export function registerTheme(id, theme) {
  if (typeof id !== 'string' || !/^[a-z][\w-]{0,31}$/.test(id)) throw new Error('Theme ids are lowercase words')
  for (const mode of ['light', 'dark']) {
    for (const key of THEME_KEYS) if (!isHex(theme?.[mode]?.[key])) throw new Error(`Theme ${mode}.${key} must be a #rrggbb color`)
  }
  const previous = customThemes[id]
  customThemes[id] = { label: String(theme.label ?? id), light: theme.light, dark: theme.dark, css: typeof theme.css === 'string' ? theme.css : '' }
  registry.set(value => value + 1)
  return () => {
    if (previous) customThemes[id] = previous
    else delete customThemes[id]
    registry.set(value => value + 1)
  }
}
export const allThemes = () => ({ ...THEMES, ...customThemes })
