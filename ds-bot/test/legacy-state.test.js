import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// A team saved by an older release, opened by this one. The saved team has no Bots, so
// the first read also makes the default Main Bot through these stand-in services.
function open(saved) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-legacy-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(saved))
  const ctx = fakeContext()
  let sessions = 0
  Object.assign(ctx, {
    workspaceRegistry: {
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup() {} } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const stop = () => {
    ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  }
  return { call, stop, home }
}

const savedTeam = prefs => ({ version: 1, mainBotIds: [], bots: {}, rooms: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs, revision: 3 })

test('a team saved with the legacy grok theme opens with the mono theme', async (t) => {
  const { call, stop, home } = open(savedTeam({ theme: 'grok', accent: '#123456' }))
  t.after(stop)
  const team = (await call('state', {})).value
  assert.deepEqual(team.prefs, { theme: 'mono', accent: '#123456' })
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).prefs.theme, 'mono')
})

test('a team saved with a current theme keeps it', async (t) => {
  const { call, stop } = open(savedTeam({ theme: 'paper' }))
  t.after(stop)
  assert.equal((await call('state', {})).value.prefs.theme, 'paper')
})

const teamWithColors = () => ({
  ...savedTeam({}),
  mainBotIds: ['m1'],
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', lab: 'deepseek', instructions: '', createdAt: 1, color: 'kimi' },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writer', lab: 'deepseek', instructions: '', createdAt: 2, color: 'violet' },
  },
})

test('Bots saved with legacy color ids open with the renamed colors', async (t) => {
  const { call, stop, home } = open(teamWithColors())
  t.after(stop)
  const colors = Object.fromEntries((await call('state', {})).value.bots.map(bot => [bot.id, bot.color]))
  assert.deepEqual(colors, { m1: 'charcoal', b2: 'violet' })
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).bots.m1.color, 'charcoal')
})

test('a legacy color id in a color change becomes the renamed color', async (t) => {
  const { call, stop } = open(teamWithColors())
  t.after(stop)
  assert.equal((await call('update-bot', { id: 'b2', color: 'qwen' })).ok, true)
  const colors = Object.fromEntries((await call('state', {})).value.bots.map(bot => [bot.name, bot.color]))
  assert.equal(colors.Writer, 'cobalt')
})
