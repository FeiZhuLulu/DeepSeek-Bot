import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as plugin from '../index.js'
import { COLORS, EXTRA_COLORS, LEGACY_COLORS, ROOM_MODES } from '../src/host/constants.js'

test('the plugin entry re-exports the shared colors', () => {
  assert.equal(plugin.name, 'ds-bot')
  assert.equal(plugin.COLORS, COLORS)
  assert.equal('LABS' in plugin, false)
  assert.equal(typeof plugin.apply, 'function')
})

test('colors and their legacy names agree', () => {
  for (const color of Object.values(LEGACY_COLORS)) assert.ok(EXTRA_COLORS.includes(color), color)
  assert.equal(new Set([...COLORS, ...EXTRA_COLORS]).size, COLORS.length + EXTRA_COLORS.length)
})

test('the reply modes are the ones the client offers', () => {
  assert.deepEqual(ROOM_MODES, ['everyone', 'admin'])
})
