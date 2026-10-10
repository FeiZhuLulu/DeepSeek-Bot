#!/usr/bin/env node
// The README logo: the whale in the middle and the other first characters on a ring
// around it, drawn from the plugin's own character table. Writes a light and a dark
// version (the dark one uses the dark inks, as the app does in dark mode).
//
//   node dev/logo.mjs [out dir]        default: ../docs/images (logo.svg, logo-dark.svg)
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SHAPES, bodyOf, holes, maskBox } from '../src/client/characters.js'
import { GRADIENTS, INKS } from '../src/client/inks.js'

const BOX = 600
const CENTER = BOX / 2
const WHALE = { shape: 'whale', color: 'deepseek', size: 300 }
// Clockwise from the top.
const RING = [
  { shape: 'star', color: 'aurora' },
  { shape: 'wave', color: 'rose' },
  { shape: 'squircle', color: 'tangerine' },
  { shape: 'moon', color: 'charcoal' },
  { shape: 'hex', color: 'cobalt' },
  { shape: 'zed', color: 'graphite' },
]
const RING_SIZE = 116
const RING_RADIUS = 228
const ORBIT = { light: '#4D6BFE', dark: '#6A84FF' }

const out = resolve(process.argv[2] ?? join(import.meta.dirname, '../../docs/images'))
mkdirSync(out, { recursive: true })
for (const mode of ['light', 'dark']) {
  const file = join(out, mode === 'light' ? 'logo.svg' : 'logo-dark.svg')
  writeFileSync(file, logo(mode))
  console.log(`wrote ${file}`)
}

function logo(mode) {
  const step = (Math.PI * 2) / RING.length
  const seats = RING.map((look, index) => {
    const angle = -Math.PI / 2 + index * step
    return { ...look, size: RING_SIZE, x: CENTER + RING_RADIUS * Math.cos(angle), y: CENTER + RING_RADIUS * Math.sin(angle) }
  })
  const orbit = `<circle cx="${CENTER}" cy="${CENTER}" r="${RING_RADIUS}" fill="none" stroke="${ORBIT[mode]}" stroke-opacity=".22" stroke-width="2" stroke-dasharray="2 10" stroke-linecap="round"/>`
  const marks = [...seats, { ...WHALE, x: CENTER, y: CENTER }].map((seat, index) => character(seat, mode, `m${index}`))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOX} ${BOX}" width="${BOX}" height="${BOX}" role="img" aria-label="DS Bot">${orbit}${marks.join('')}</svg>\n`
}

// One character in a `size` box centered on (x, y). The eyes are cut out of the body,
// so they show the page behind the logo.
function character({ shape, color, size, x, y }, mode, id) {
  const def = SHAPES[shape]
  const scale = size / def.size
  const stops = GRADIENTS[color]
  const paint = stops ? `url(#${id}g)` : INKS[color][mode === 'light' ? 0 : 1]
  const gradient = stops ? `<linearGradient id="${id}g" gradientUnits="userSpaceOnUse" x1="18" y1="10" x2="78" y2="92">${stops.map(([offset, value]) => `<stop offset="${offset}" stop-color="${value}"/>`).join('')}</linearGradient>` : ''
  const eyes = def.eyes.map(([cx, cy, w, h, tilt]) => `<g transform="translate(${cx} ${cy}) rotate(${tilt})"><rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${w / 2}" fill="#000"/></g>`).join('')
  const place = `translate(${(x - size / 2).toFixed(1)} ${(y - size / 2).toFixed(1)}) scale(${scale})`
  return `<g transform="${place}"><defs>${gradient}<mask id="${id}" ${maskBox(def.size)}>${holes(def, eyes)}</mask></defs><g mask="url(#${id})">${bodyOf(def, paint)}</g></g>`
}
