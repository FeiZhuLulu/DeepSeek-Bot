import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inkFill } from '../src/client/inks.js'

test('a reply that still carries a legacy color id paints in the renamed ink', () => {
  assert.equal(inkFill('kimi'), 'var(--bt-ink-charcoal)')
  assert.equal(inkFill('qwen'), 'var(--bt-ink-cobalt)')
  assert.equal(inkFill('rose'), 'var(--bt-ink-rose)')
  assert.equal(inkFill('nope'), 'var(--bt-ink-gray)')
})
