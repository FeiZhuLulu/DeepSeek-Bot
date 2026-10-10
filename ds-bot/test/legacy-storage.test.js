import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STORAGE, legacyKeys, migrateStorage } from '../src/client/storage.js'

const memoryStorage = (entries = {}) => {
  const map = new Map(Object.entries(entries))
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
  }
}

test('values saved under the dsh-bot keys move to the ds-bot keys', () => {
  const storage = memoryStorage({
    'dsh-bot:unread': '{"a":true}',
    'dsh-bot:reactions': '{"t1":"👍"}',
    'dsh-bot:seen': '{"a":1}',
    'dsh-bot:prefs': '{"theme":"paper"}',
    'dsh-bot:browser-width': '600',
    'dsh-bot.browser.v1': '{"a":{"url":"https://example.com/"}}',
    'other:key': 'kept',
  })
  migrateStorage(storage)
  assert.deepEqual(Object.fromEntries(storage.map), {
    'ds-bot:unread': '{"a":true}',
    'ds-bot:reactions': '{"t1":"👍"}',
    'ds-bot:seen': '{"a":1}',
    'ds-bot:prefs': '{"theme":"paper"}',
    'ds-bot:browser-width': '600',
    'ds-bot.browser.v2': '{"a":{"tabs":[{"id":"v1-a","url":"https://example.com/","title":""}],"active":"v1-a"}}',
    'other:key': 'kept',
  })
})

test('the dsh-bot-team keys move too, and the newer name wins', () => {
  const storage = memoryStorage({ 'dsh-bot-team:unread': 'oldest', 'dsh-bot-team:prefs': 'team', 'dsh-bot:prefs': 'newer' })
  migrateStorage(storage)
  assert.equal(storage.getItem(STORAGE.unread), 'oldest')
  assert.equal(storage.getItem(STORAGE.prefs), 'newer')
  assert.equal(storage.getItem('dsh-bot-team:prefs'), null)
})

test('a value already under the current key is never overwritten', () => {
  const storage = memoryStorage({ 'ds-bot:seen': 'current', 'dsh-bot:seen': 'old' })
  migrateStorage(storage)
  assert.equal(storage.getItem(STORAGE.seen), 'current')
  assert.equal(storage.getItem('dsh-bot:seen'), null)
  migrateStorage(storage)
  assert.equal(storage.getItem(STORAGE.seen), 'current')
})

test('every current key has its legacy keys, and unusable storage is no error', () => {
  for (const key of Object.values(STORAGE)) assert.ok(legacyKeys(key).length > 0, key)
  const broken = { getItem: () => { throw new Error('denied') }, setItem() {}, removeItem() {} }
  assert.doesNotThrow(() => migrateStorage(broken))
})

test('a saved legacy grok theme becomes the mono theme', () => {
  const storage = memoryStorage({ 'dsh-bot:prefs': '{"theme":"grok","accent":"#123456"}' })
  migrateStorage(storage)
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE.prefs)), { theme: 'mono', accent: '#123456' })
  migrateStorage(memoryStorage({ 'ds-bot:prefs': 'not json' }))
})
