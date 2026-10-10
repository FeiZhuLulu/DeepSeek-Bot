import assert from 'node:assert/strict'
import { test } from 'node:test'
import { termQuery } from '../src/host/chat-index.js'
import { cardText, historyEntry, questionReply, readReply, replyText } from '../src/host/parts.js'

test('cardText shows a question card as the user saw it', () => {
  const card = { question: ' Start where? ', detail: 'pick one', options: [{ label: 'Plan' }, { label: ' ' }, { label: 'Draft' }] }
  assert.equal(cardText(card), '[Question card] Start where? (pick one)\nOptions: Plan / Draft')
  assert.equal(cardText(JSON.stringify({ question: 'Q', options: [{ label: 'A' }] })), '[Question card] Q\nOptions: A')
  assert.equal(cardText('{not json'), '')
  assert.equal(cardText({ question: 'Q', options: ['A'] }), '')
  assert.equal(cardText({ question: '', options: [{ label: 'A' }] }), '')
  assert.equal(cardText({ question: 'Q', options: [] }), '')
})

const said = (text, source) => ({ type: 'user/message', data: { content: [{ type: 'text', text }], source } })

test('historyEntry keeps answers, user and Bot messages, and skips setup', () => {
  assert.deepEqual(historyEntry({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Hi' }] } } }, false), { answer: true, text: 'Hi' })
  assert.equal(historyEntry({ type: 'assistant/message', data: { message: { content: [] } } }, false), undefined)
  const ask = { type: 'tool/call', data: { name: 'ask_user', arguments: { question: 'Q', options: [{ label: 'A' }] } } }
  assert.deepEqual(historyEntry(ask, false), { answer: true, text: '[Question card] Q\nOptions: A' })
  assert.equal(historyEntry(ask, true), undefined)
  assert.deepEqual(historyEntry(said('hello', { kind: 'user' }), false), { answer: false, who: 'user', text: 'hello', keepAnswers: true })
  assert.deepEqual(historyEntry(said('[Reply from W]\nok', { kind: 'bot', role: 'reply' }), false), { answer: false, who: 'bot', text: '[Reply from W]\nok', keepAnswers: true })
  assert.deepEqual(historyEntry(said('[Bot team setup]\nhi', { kind: 'bot', role: 'kickoff' }), false), { answer: false, who: 'bot', text: '', keepAnswers: false })
  assert.deepEqual(historyEntry(said('[Handoff · part 2]', { kind: 'bot', handoff: true }), false), { answer: false, who: 'bot', text: '', keepAnswers: false })
  assert.deepEqual(historyEntry(said('[Handoff · part 2]', { kind: 'bot', handoff: true, resume: true }), false), { answer: false, who: 'bot', text: '', keepAnswers: true })
  assert.deepEqual(historyEntry(said('[Group chat "G" · new message]', { kind: 'bot', role: 'room' }), false), { answer: false, who: 'bot', text: '', keepAnswers: false })
  assert.equal(historyEntry(said('[Group chat "G" · new message]', { kind: 'bot', role: 'room' }), true).text, '[Group chat "G" · new message]')
  assert.equal(historyEntry(said('time: now', { kind: 'plugin' }), false), undefined)
})

test('termQuery matches long words with FTS5 and short ones with LIKE', () => {
  const sessions = ['s1', 's2']
  assert.deepEqual(termQuery(['needle', 'a"b"c'], sessions, 20), {
    sql: 'SELECT text, session, seq, time, who FROM lines WHERE lines MATCH ? AND session IN (SELECT value FROM json_each(?)) ORDER BY rank LIMIT 20',
    args: ['"needle" "a""b""c"', '["s1","s2"]'],
  })
  assert.deepEqual(termQuery(['会议', '5%'], sessions, 5, { session: 's2', from: 40 }), {
    sql: "SELECT text, session, seq, time, who FROM lines WHERE session IN (SELECT value FROM json_each(?)) AND NOT (session = ? AND seq >= ?) AND text LIKE ? ESCAPE '\\' AND text LIKE ? ESCAPE '\\' ORDER BY time DESC LIMIT 5",
    args: ['["s1","s2"]', 's2', 40, '%会议%', '%5\\%%'],
  })
})

test('a card answer carries its question, so it reads on its own', () => {
  const question = { id: 'q1', callId: 'call-1', question: 'Start where?', options: [{ label: 'Plan' }, { label: 'Draft' }], multiSelect: false }
  const reply = questionReply(question, { selected: ['Draft', 'Plan'], custom: '  ' })
  assert.deepEqual(reply.source, { kind: 'user-question-reply', callId: 'call-1', outcome: 'answered' })
  const payload = JSON.parse(reply.text)
  assert.equal(payload.tool, 'ask_user')
  assert.deepEqual(payload.answers, [{ id: 'q1', selected: ['Draft'] }])
  assert.equal(replyText(reply.text), '[Answer to question card] Start where?\nAnswer: Draft')
  const event = { type: 'user/message', data: { source: reply.source, content: [{ type: 'text', text: reply.text }] } }
  assert.deepEqual(historyEntry(event, false), { answer: false, who: 'user', text: '[Answer to question card] Start where?\nAnswer: Draft', keepAnswers: true })
  assert.deepEqual(readReply(reply.text).questions[0].options, question.options)
})

test('a card answer keeps several picks and the user\'s own words', () => {
  const question = { id: 'q1', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }
  const reply = questionReply(question, { selected: ['A', 'B', 'Z'], custom: 'also C' })
  assert.equal(reply.source.callId, 'q1')
  assert.equal(replyText(reply.text), '[Answer to question card] Which?\nAnswer: A, B, also C')
  assert.equal(questionReply(question, { selected: ['Z'], custom: '' }), undefined)
  assert.equal(replyText('plain words'), 'plain words')
})
