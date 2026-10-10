import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPass, mentionsIn, stripOwnName } from '../src/host/groups.js'

const members = [{ name: 'M' }, { name: 'Mx' }, { name: 'K' }, { name: 'Writer' }]
const names = ({ all, found }) => ({ all, found: found.map(member => member.name) })

test('mentionsIn finds members in order, longest name first', () => {
  assert.deepEqual(names(mentionsIn('@Mx and @M, then @writer', members)), { all: false, found: ['Mx', 'M', 'Writer'] })
  assert.deepEqual(names(mentionsIn('@K你好 @K again', members)), { all: false, found: ['K'] })
  assert.deepEqual(names(mentionsIn('@Kate is not K', members)), { all: false, found: [] })
  assert.deepEqual(names(mentionsIn('mail a@K.com', members)), { all: false, found: [] })
  assert.deepEqual(names(mentionsIn('@all please, @所有人', members)), { all: true, found: [] })
  assert.deepEqual(names(mentionsIn('@everyone and @M', members)), { all: true, found: ['M'] })
  assert.deepEqual(names(mentionsIn('no mentions', members)), { all: false, found: [] })
})

test('isPass takes empty replies and [PASS] forms', () => {
  for (const text of ['', '[PASS]', ' 【pass】 then more', '(pass)', 'pass.', 'Pass！', '  PASS  ']) assert.equal(isPass(text), true, text)
  for (const text of ['passing the ball', 'I pass on this one', 'ok']) assert.equal(isPass(text), false, text)
})

test('stripOwnName drops an echoed "Name:" prefix', () => {
  assert.equal(stripOwnName('Writer', 'Writer: hello'), 'hello')
  assert.equal(stripOwnName('Writer', '**Writer**：你好'), '你好')
  assert.equal(stripOwnName('A.b', 'A.b: x'), 'x')
  assert.equal(stripOwnName('A.b', 'Axb: x'), 'Axb: x')
  assert.equal(stripOwnName('Writer', 'Coder: hi'), 'Coder: hi')
})
