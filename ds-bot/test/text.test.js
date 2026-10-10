import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clip, createClock, escapeRegExp, estimateTokens, excerpt, isColor, normalize, splitRef, textOf, unquote } from '../src/host/text.js'

test('textOf joins the text blocks only', () => {
  assert.equal(textOf([{ type: 'text', text: ' a ' }, { type: 'image' }, { type: 'text', text: 'b' }, { type: 'text', text: 3 }]), 'a \nb')
  assert.equal(textOf(undefined), '')
  assert.equal(textOf('plain'), '')
})

test('normalize and unquote', () => {
  assert.equal(normalize('  MiXed '), 'mixed')
  assert.equal(normalize(null), '')
  assert.equal(unquote(' 「项目组」 '), '项目组')
  assert.equal(unquote('"Team"'), 'Team')
  assert.equal(unquote(undefined), '')
})

test('splitRef splits at the first slash', () => {
  assert.deepEqual(splitRef('ollama/deepseek-v4-pro:0813'), { provider: 'ollama', model: 'deepseek-v4-pro:0813' })
  assert.deepEqual(splitRef('a/b/c'), { provider: 'a', model: 'b/c' })
  assert.equal(splitRef('/model'), undefined)
  assert.equal(splitRef('model'), undefined)
  assert.equal(splitRef(undefined), undefined)
})

test('isColor takes avatar inks, extra inks, and #rrggbb', () => {
  assert.equal(isColor('aurora'), true)
  assert.equal(isColor('charcoal'), true)
  assert.equal(isColor('#A0b1C2'), true)
  assert.equal(isColor('#abc'), false)
  assert.equal(isColor('pink'), false)
  assert.equal(isColor(undefined), false)
})

test('escapeRegExp makes a literal pattern', () => {
  const name = 'A.b*(c)?[d]'
  assert.equal(new RegExp(`^${escapeRegExp(name)}$`).test(name), true)
  assert.equal(new RegExp(`^${escapeRegExp(name)}$`).test('Axb*(c)?[d]'), false)
})

test('excerpt keeps the match in view', () => {
  assert.equal(excerpt('short', 'x'), 'short')
  const long = `${'a'.repeat(500)}needle${'b'.repeat(500)}`
  const cut = excerpt(long, 'needle', 200)
  assert.ok(cut.startsWith('…'))
  assert.ok(cut.endsWith('…'))
  assert.ok(cut.includes('needle'))
  assert.equal(excerpt(long, '', 10), `${'a'.repeat(10)}…`)
})

test('estimateTokens counts CJK as one token and other text as a third', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('你好'), 2)
  assert.equal(estimateTokens('abc'), 2)
  // Summing 0.34 per character runs a hair over, so ceil may add one; it stays an upper bound.
  const tokens = estimateTokens('a'.repeat(100))
  assert.ok(tokens >= 34 && tokens <= 35, String(tokens))
})

test('clip cuts long text and says where the rest is', () => {
  assert.equal(clip('abc', 5, 'x'), 'abc')
  assert.equal(clip('abcdef', 3, 'see part 2'), 'abc… (cut; see part 2)')
})

test('createClock formats month, day, and 24-hour time', () => {
  const clock = createClock('UTC')
  assert.equal(clock(Date.UTC(2025, 9, 8, 14, 22)), '10-08 14:22')
  assert.equal(clock(Date.UTC(2025, 0, 2, 0, 5)), '01-02 00:05')
  assert.equal(clock(undefined), '?')
  assert.equal(clock(Number.NaN), '?')
})
