import assert from 'node:assert/strict'
import { test } from 'node:test'
import { linkMentions, MENTION_ORIGIN } from '../src/client/text.js'

const bots = [{ id: 'a', name: '新 Bot' }, { id: 'b', name: '新 Bot 2' }, { id: 'c', name: 'Chief' }, { id: 't', name: '测试' }]

test('a bare name is ordinary text, even when a Bot has that name', () => {
  assert.equal(linkMentions('76 项测试通过，问问 Chief', bots, 'a'), '76 项测试通过，问问 Chief')
})

test('a Bot naming itself is not taken for a Bot whose name is a prefix of its own', () => {
  assert.equal(linkMentions('你好！我是 @新 Bot 2，很高兴加入', bots, 'b'), '你好！我是 @新 Bot 2，很高兴加入')
})

test('the longest name wins, and other Bots are still linked', () => {
  assert.equal(linkMentions('@新 Bot 2 和 @chief', bots, 'a'), `[新 Bot 2](${MENTION_ORIGIN}b) 和 [chief](${MENTION_ORIGIN}c)`)
  assert.equal(linkMentions('问问@新 Bot。', bots, 'b'), `问问[新 Bot](${MENTION_ORIGIN}a)。`)
  assert.equal(linkMentions('@测试你看下', bots, 'a'), `[测试](${MENTION_ORIGIN}t)你看下`)
})

test('addresses, longer words and code are left alone', () => {
  assert.equal(linkMentions('mail me@Chief.dev', bots, 'a'), 'mail me@Chief.dev')
  assert.equal(linkMentions('@Chiefs 来了', bots, 'a'), '@Chiefs 来了')
  assert.equal(linkMentions('run `@Chief` now', bots, 'a'), 'run `@Chief` now')
})
