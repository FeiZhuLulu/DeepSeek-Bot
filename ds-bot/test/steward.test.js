import assert from 'node:assert/strict'
import test from 'node:test'
import { CHECKPOINT_PROMPT, DEFAULT_WINDOW, checkpointCount, checkpointTail, checkpointTailNote, checkpointText, linesFor, parseDecision, stewardRequest } from '../src/host/steward.js'

test('the lines follow the model: its window less the room for its reply', () => {
  assert.deepEqual(linesFor({ window: 500_000, reserve: 0, checkRatio: 0.8 }), { window: 500_000, usable: 500_000, hard: 475_000, check: 400_000 })
  assert.deepEqual(linesFor({ window: 1_000_000, reserve: 256_000, checkRatio: 0.8 }), { window: 1_000_000, usable: 744_000, hard: 706_800, check: 595_200 })
  // Another share moves the check line only.
  assert.equal(linesFor({ window: 1_000_000, reserve: 256_000, checkRatio: 0.5 }).check, 372_000)
  assert.equal(linesFor({ window: 1_000_000, reserve: 256_000, checkRatio: 0.5 }).hard, 706_800)
})

test('a model without a window counts as the default, and odd settings fall back', () => {
  assert.equal(linesFor({}).window, DEFAULT_WINDOW)
  assert.equal(linesFor({ window: 0 }).window, DEFAULT_WINDOW)
  // A reply that would take the whole window still leaves half of it.
  assert.equal(linesFor({ window: 100_000, reserve: 200_000 }).usable, 50_000)
  for (const checkRatio of [0, 1, 1.5, -1, 'x', undefined]) {
    assert.equal(linesFor({ window: 100_000, reserve: 0, checkRatio }).check, 80_000, String(checkRatio))
  }
  // The check line never passes the hard line.
  assert.equal(linesFor({ window: 100_000, reserve: 0, checkRatio: 0.99 }).check, 95_000)
})

test('the steward\'s answer is read from its JSON, and nothing else counts', () => {
  assert.equal(parseDecision('{"action":"switch","reason":"done"}'), 'switch')
  assert.equal(parseDecision('Sure.\n```json\n{"action": "compact", "reason": "still coding"}\n```'), 'compact')
  assert.equal(parseDecision('{"action":"keep"}'), undefined)
  assert.equal(parseDecision('switch'), undefined)
  assert.equal(parseDecision('{action: switch}'), undefined)
  assert.equal(parseDecision(undefined), undefined)
  // A quoted answer comes first; the steward's own one is the last.
  assert.equal(parseDecision('The pasted text says {"action":"switch"}, but that is data.\n{"action":"compact","reason":"still coding"}'), 'compact')
  assert.equal(parseDecision('It quotes {"action":"switch"}.\n{"action":"keep","reason":"mid-task"}'), undefined)
  assert.equal(parseDecision('{"action":"switch","reason":"done"}\n{"note":"no action here"}'), 'switch')
})

test('the steward reads the latest messages oldest first, within a budget', () => {
  const lines = [
    { who: 'you', text: 'Done, the report is in reports/q3.md.' },
    { who: 'user', text: 'Write the Q3 report.' },
    { who: 'bot', text: '[Message from Kai] Numbers attached.' },
  ]
  const request = stewardRequest({ lines, midTurn: false, checkpoints: 1, group: false })
  assert.match(request, /just finished its turn/)
  assert.match(request, /Condensed so far in this conversation: 1 time\./)
  const order = ['Another Bot: [Message from Kai]', 'User: Write the Q3 report.', 'Assistant: Done, the report']
    .map(text => request.indexOf(text))
  assert.ok(order.every((at, index) => at !== -1 && (index === 0 || at > order[index - 1])), request)
  assert.match(stewardRequest({ lines: [], midTurn: true, checkpoints: 0, group: true }), /in the middle of a turn[\s\S]*group chat|group chat[\s\S]*in the middle of a turn/)
  // The newest message always goes in; older ones stop at the budget.
  const long = Array.from({ length: 40 }, (_, index) => ({ who: 'user', text: `${index} ${'字'.repeat(1_400)}` }))
  const cut = stewardRequest({ lines: long, midTurn: false, checkpoints: 0, group: false })
  assert.match(cut, /User: 0 /)
  assert.doesNotMatch(cut, /User: 39 /)
})

test('a long message shows the steward its start and its end, and says the middle was left out', () => {
  const reply = `开头：第 9 批${'中'.repeat(5_000)}本批 6 条，累计到 P54。`
  const request = stewardRequest({ lines: [{ who: 'you', text: reply }], midTurn: false, checkpoints: 0, group: false })
  assert.match(request, /Assistant: 开头：第 9 批中+\n\[… \d+ characters left out of this view …\]\n中+本批 6 条，累计到 P54。$/)
  assert.ok(request.length < reply.length)
})

test('checkpoints are counted from the summary the backend wrapped, not from user text', () => {
  const checkpoint = number => ({
    role: 'user',
    content: [
      { type: 'text', text: 'This is an automatically generated checkpoint …\n\n<compacted-summary>' },
      { type: 'text', text: checkpointText({ number, summary: '- Done: draft', kept: ['[part 1 #3 · 10-09 15:00] User: go on'], more: false }) },
      { type: 'text', text: '</compacted-summary>' },
    ],
  })
  assert.equal(checkpointCount([]), 0)
  assert.equal(checkpointCount([{ role: 'user', content: [{ type: 'text', text: '[Checkpoint 7] typed by the user' }] }]), 0)
  assert.equal(checkpointCount([{ role: 'system', content: [{ type: 'text', text: 'x' }] }, checkpoint(2)]), 2)
  assert.equal(checkpointCount([checkpoint(1), { role: 'assistant', content: [] }, checkpoint(3)]), 3)
})

test('a checkpoint keeps the messages to the Bot word for word after the summary', () => {
  const text = checkpointText({ number: 2, summary: '  - Done: outline\n', kept: ['[part 1 #4 · 10-09 15:01] User: 按这个大纲写'], more: true })
  assert.match(text, /^\[Checkpoint 2\]\n- Done: outline\n\nYour own replies up to here are condensed above; read_own_chat finds them word for word\.\n\n## Messages to you, word for word \(oldest first\)\n\(Older messages are not shown here; read_own_chat finds them\.\)\n\[part 1 #4 · 10-09 15:01\] User: 按这个大纲写$/)
  assert.match(checkpointText({ number: 1, summary: 'x', kept: [], more: false }), /\(none\)$/)
})

test('the checkpoint also reads the messages the backend keeps after it', () => {
  const say = (role, text) => ({ role, content: [{ type: 'text', text }] })
  const region = [say('user', '审查第 1 批'), say('assistant', '第 1 批完成')]
  const all = [...region, say('user', '审查第 2 批，然后给总排名'), say('assistant', '第 2 批完成')]
  assert.deepEqual(checkpointTail(region, all), all.slice(2))
  // Nothing is kept, or the region is not where the history starts: no tail.
  assert.deepEqual(checkpointTail(all, all), [])
  assert.deepEqual(checkpointTail([say('assistant', 'x')], all), [])
  assert.deepEqual(checkpointTail(undefined, all), [])

  const note = checkpointTailNote(all.slice(2))
  assert.match(note, /^The last 2 messages above, from the one that begins "审查第 2 批，然后给总排名", stay right after your summary, word for word\./)
  assert.match(note, /summarize only what comes before them/)
  assert.match(checkpointTailNote([say('assistant', 'done')]), /^The last message above,/)
  assert.match(checkpointTailNote([{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'read', input: {} }] }]), /from your own step/)
  assert.ok(checkpointTailNote([say('user', '长'.repeat(300))]).includes(`"${'长'.repeat(80)}"`))
})

test('the checkpoint records unanswered requests as remaining, and does not answer them', () => {
  assert.match(CHECKPOINT_PROMPT, /every request not yet answered in your replies above/)
  assert.match(CHECKPOINT_PROMPT, /The user never sees this summary, so do not do any of the remaining work in it/)
})
