import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupsFor, readMode, writeMode } from '../src/client/surface.js'
import { STORAGE } from '../src/client/storage.js'

test('Bot mode mounts both groups; Agent mode mounts neither', () => {
  assert.deepEqual(groupsFor({ mode: 'bot' }), { shell: true, conversation: true })
  assert.deepEqual(groupsFor({ mode: 'bot', plain: false }), { shell: true, conversation: true })
  assert.deepEqual(groupsFor({ mode: 'agent' }), { shell: false, conversation: false })
  assert.deepEqual(groupsFor({ mode: 'agent', plain: true }), { shell: false, conversation: false })
})

test('a plain Bot-mode view keeps the shell but drops the conversation', () => {
  assert.deepEqual(groupsFor({ mode: 'bot', plain: true }), { shell: true, conversation: false })
})

test('the saved surface mode survives reloads and defaults to bot', () => {
  const store = new Map()
  const storage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: key => store.delete(key),
  }
  assert.equal(readMode(storage), 'bot')
  writeMode('agent', storage)
  assert.equal(readMode(storage), 'agent')
  writeMode('bot', storage)
  assert.equal(readMode(storage), 'bot')
  store.set(STORAGE.surface, 'nonsense')
  assert.equal(readMode(storage), 'bot')
})

test('readMode falls back to bot when storage throws', () => {
  assert.equal(readMode({ getItem: () => { throw new Error('denied') } }), 'bot')
})
