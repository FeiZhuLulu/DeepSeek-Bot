import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FLAT_TRANSCRIPT_VIEW, holdFlatTranscript } from '../src/client/flat-transcript.js'

// A ui-chat config form: `set` records the write; `accept` and `refuse` settle it the
// way the Host would (a new revision with the value, or the same revision reloaded).
function fakeForm(snapshot) {
  let current = { status: 'ready', writable: true, mode: 'host', revision: 1, ...snapshot }
  const listeners = new Set()
  const writes = []
  const publish = (next) => { current = next; for (const listener of [...listeners]) listener() }
  return {
    writes,
    listeners,
    getSnapshot: () => current,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    set: (field, value) => { writes.push([field, value]); return Promise.resolve(true) },
    publish,
    accept: value => publish({ ...current, revision: current.revision + 1, value: { ...current.value, transcriptView: value } }),
    refuse: () => publish({ ...current }),
  }
}

test('Desktop first-run `standard` is replaced by the flat mode', () => {
  const form = fakeForm({ value: { transcriptView: 'standard' } })
  const stop = holdFlatTranscript(form)
  assert.deepEqual(form.writes, [['transcriptView', FLAT_TRANSCRIPT_VIEW]])
  form.accept(FLAT_TRANSCRIPT_VIEW)
  assert.equal(form.writes.length, 1)
  stop()
  assert.equal(form.listeners.size, 0)
})

test('an unset mode is written, and nothing is written before the section arrives', () => {
  const form = fakeForm({ status: 'loading', value: undefined, revision: undefined })
  holdFlatTranscript(form)
  assert.equal(form.writes.length, 0)
  form.publish({ ...form.getSnapshot(), status: 'ready', revision: 3, value: {} })
  assert.deepEqual(form.writes, [['transcriptView', 'verbose']])
})

test('a flat mode already saved is left alone', () => {
  const form = fakeForm({ value: { transcriptView: 'verbose' } })
  holdFlatTranscript(form)
  form.publish({ ...form.getSnapshot() })
  assert.equal(form.writes.length, 0)
})

test('a later change away from flat is undone', () => {
  const form = fakeForm({ value: { transcriptView: 'verbose' } })
  holdFlatTranscript(form)
  form.accept('compact')
  assert.deepEqual(form.writes, [['transcriptView', 'verbose']])
})

test('a refused write is not retried in a loop', () => {
  const form = fakeForm({ value: { transcriptView: 'detailed' } })
  holdFlatTranscript(form)
  form.refuse()
  form.refuse()
  assert.equal(form.writes.length, 1)
  // A new Host revision is a new chance.
  form.accept('detailed')
  assert.equal(form.writes.length, 2)
})

test('process-local or read-only settings are never written', () => {
  const memory = fakeForm({ status: 'unavailable', mode: 'memory', writable: false, value: undefined })
  holdFlatTranscript(memory)
  const readOnly = fakeForm({ writable: false, value: { transcriptView: 'standard' } })
  holdFlatTranscript(readOnly)
  assert.equal(memory.writes.length + readOnly.writes.length, 0)
})

test('a rejected write does not escape', async () => {
  const form = fakeForm({ value: { transcriptView: 'standard' } })
  form.set = () => Promise.reject(new Error('offline'))
  holdFlatTranscript(form)
  await new Promise(resolve => setImmediate(resolve))
})
