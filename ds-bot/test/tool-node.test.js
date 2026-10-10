import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toolArgs, toolName } from '../src/client/text.js'

const argsRaw = JSON.stringify({ name: 'GITHUB_TOKEN', purpose: 'GitHub', questions: [{ question: 'Which?' }] })

test('a finished call that carries its name and arguments only under `call` is still read', () => {
  const root = { kind: 'tool-result', callId: 'c1', call: { name: 'request_secret', argsRaw }, content: [] }
  const args = toolArgs(root)
  assert.equal(toolName(root), 'request_secret')
  assert.equal(args.text('name'), 'GITHUB_TOKEN')
  assert.deepEqual(args.value('questions'), [{ question: 'Which?' }])
  assert.equal(args.text('questions'), undefined)
  assert.equal(args.text('missing'), undefined)
})

test('a running call is read from its own name and raw arguments', () => {
  const root = { phase: 'start', callId: 'c1', name: 'request_secret', argsRaw }
  assert.equal(toolName(root), 'request_secret')
  assert.equal(toolArgs(root).text('name'), 'GITHUB_TOKEN')
})

test('a node with an argument reader uses the reader', () => {
  const reader = { text: key => (key === 'to' ? 'Coder' : undefined), value: key => (key === 'to' ? 'Coder' : undefined) }
  const root = { kind: 'tool-result', name: 'message_bot', args: reader, call: { name: 'message_bot', argsRaw: '{"to":"Other"}' } }
  assert.equal(toolName(root), 'message_bot')
  assert.equal(toolArgs(root).text('to'), 'Coder')
  assert.equal(toolArgs(root).value('to'), 'Coder')
})

test('an empty name falls back to the call, and unreadable arguments read as absent', () => {
  const root = { kind: 'tool-result', name: '', call: { name: 'ask_user', argsRaw: '{"question":' } }
  assert.equal(toolName(root), 'ask_user')
  assert.equal(toolArgs(root).text('question'), undefined)
  assert.equal(toolArgs({ kind: 'tool-result', call: null }).value('x'), undefined)
  assert.equal(toolArgs({ argsRaw: '[1]' }).value('0'), undefined)
})
