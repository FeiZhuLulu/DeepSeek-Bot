import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Enough of the dsh services for the roster to make Sessions; kickoff messages are dropped.
function start(team, { models = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-roster-'))
  if (team !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext()
  const workspaces = new Map()
  const sent = []
  const selected = []
  let sessions = 0
  Object.assign(ctx, {
    llm: {
      listProviders: () => (models.length > 0 ? [{ id: 'deepseek', name: 'DeepSeek' }] : []),
      listModels: async () => models.map(id => ({ id })),
    },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async path => [...workspaces.values()].find(workspace => workspace.path === path),
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: message => sent.push({ sessionId, message }) } }),
      selectModel: async (request) => { selected.push(request) },
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
  return { call, stop, home, sent, selected, ctx }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

test('the first Main Bot waits for the user to pick a model, then greets', async (t) => {
  const { call, stop, sent, selected } = start(undefined, { models: ['deepseek-v4-flash', 'deepseek-v4-pro'] })
  t.after(stop)
  let team = (await call('state', {})).value
  let main = team.bots.find(bot => bot.id === team.mainBotId)
  await settle()
  assert.equal(main.model, undefined)
  assert.equal(main.waiting, true)
  assert.equal(main.kickoff, undefined)
  assert.equal(sent.length, 0)
  assert.equal(selected.length, 0)
  assert.deepEqual(team.models.map(model => model.ref), ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro'])
  assert.equal(team.defaultModel, 'deepseek/deepseek-v4-flash')

  assert.equal((await call('update-bot', { id: main.id, model: 'deepseek/deepseek-v4-pro' })).ok, true)
  await settle()
  team = (await call('state', {})).value
  main = team.bots.find(bot => bot.id === team.mainBotId)
  assert.equal(main.model, 'deepseek/deepseek-v4-pro')
  assert.equal(main.waiting, undefined)
  assert.deepEqual(selected.map(({ sessionId, model }) => [sessionId, model]), [[main.id, 'deepseek-v4-pro']])
  assert.equal(sent.length, 1)
  assert.equal(sent[0].sessionId, main.id)
  assert.equal(sent[0].message.source.role, 'kickoff')

  // A later model change does not greet again.
  await call('update-bot', { id: main.id, model: 'deepseek/deepseek-v4-flash' })
  await settle()
  assert.equal(sent.length, 1)
})

test('other Bots start on the default model and greet at once', async (t) => {
  const { call, stop, sent } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  await call('state', {})
  const writer = (await call('create-bot', { name: 'Writer' })).value
  await settle()
  assert.equal(writer.model, 'deepseek/deepseek-v4-flash')
  assert.deepEqual(sent.map(entry => entry.sessionId), [writer.id])
})

test('a group the user makes without a first message opens with its admin asking what it is for', async (t) => {
  const { call, stop, sent, ctx, home } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  await settle()
  sent.length = 0
  await call('create-room', { members: [chief, writer.id], admin: writer.id })
  assert.equal(sent.length, 0)
  const room = (await call('create-room', { members: [chief, writer.id], admin: writer.id, greet: true })).value
  assert.deepEqual(sent.map(entry => [entry.sessionId, entry.message.source.role]), [[room.id, 'kickoff']])

  // The relay gives the admin alone a turn, and the cue adds no line to the group.
  for (const listener of ctx.listeners.get('session/event')) listener({ id: room.id }, { type: 'user/message', data: sent[0].message })
  const controller = new AbortController()
  const relay = ctx.registeredTools.get('group_relay').execute({}, { agent: { id: room.id }, callId: 'relay', signal: controller.signal })
  await settle()
  controller.abort()
  const result = JSON.parse(await relay)
  const turns = sent.slice(1)
  assert.equal(turns.length, 1)
  const text = turns[0].message.content[0].text
  assert.match(text, /^\[Group chat "[^"]+" · the group was just created\]\n/)
  assert.match(text, /The user just created this group/)
  assert.doesNotMatch(text, /This round so far|Nothing new in this round/)
  assert.deepEqual(result.passed, ['Writer'])
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).rooms[room.id]
  assert.equal(saved.sessions[writer.id], turns[0].sessionId)
  assert.deepEqual(saved.log, [])
})

test('the state reports a changed model list without a new revision', async (t) => {
  const { call, stop } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const first = (await call('state', {})).value
  assert.equal((await call('state', { since: first.revision, models: first.modelsKey })).value.unchanged, true)
  assert.equal((await call('state', { since: first.revision, models: 'stale' })).value.unchanged, undefined)
})

test('a new team starts with a DeepSeek-blue whale as its Main Bot', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const team = (await call('state', {})).value
  assert.equal(team.mainBotIds.length, 1)
  const main = team.bots.find(bot => bot.id === team.mainBotId)
  assert.equal(main.name, 'Chief')
  assert.equal(main.color, 'deepseek')
  assert.deepEqual(main.avatar, { shape: 'whale' })

  // Other Bots keep no stored look, so the client picks one from the id.
  const writer = (await call('create-bot', { name: 'Writer', role: '写作' })).value
  assert.equal(writer.color, undefined)
  assert.equal(writer.avatar, undefined)
  // Making a Bot a Main Bot later does not change how it looks.
  await call('set-main', { id: writer.id, main: true })
  const after = (await call('state', {})).value.bots.find(bot => bot.id === writer.id)
  assert.equal(after.color, undefined)
  assert.equal(after.avatar, undefined)
})

const OLD_TEAM = {
  version: 1,
  mainBotIds: ['m1', 'w2'],
  revision: 4,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', lab: 'deepseek', instructions: '', createdAt: 1, color: 'red' },
    w2: { id: 'w2', sessionId: 'w2', name: 'Writer', role: '写作', lab: 'kimi', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

test('a team from before the whale was stored gets it once, on its first Main Bot only', async (t) => {
  const { call, stop, home } = start(OLD_TEAM)
  t.after(stop)
  const bots = async () => Object.fromEntries((await call('state', {})).value.bots.map(bot => [bot.id, bot]))
  let team = await bots()
  // A color the user picked stays; the missing shape becomes the whale.
  assert.equal(team.m1.color, 'red')
  assert.deepEqual(team.m1.avatar, { shape: 'whale' })
  assert.equal(team.w2.avatar, undefined)
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).whaleStored, true)

  // The whale is now an ordinary look: it does not pass on when its Bot is deleted.
  assert.equal((await call('set-main', { id: 'm1', main: false })).ok, true)
  assert.equal((await call('delete-bot', { id: 'm1' })).ok, true)
  team = await bots()
  assert.equal(team.w2.avatar, undefined)
  assert.equal(team.w2.color, undefined)
})

test('another Bot takes the Main Bot place in one step', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const team = (await call('set-main', { id: writer.id, main: true, replace: chief })).value
  assert.deepEqual(team.mainBotIds, [writer.id])
  assert.equal(team.mainBotId, writer.id)
  // The whale stays with the Bot it was given to.
  assert.deepEqual(team.bots.find(bot => bot.id === chief).avatar, { shape: 'whale' })
  // The old Main Bot can now be deleted, and no new Chief is made in its place.
  assert.equal((await call('delete-bot', { id: chief })).ok, true)
  const after = (await call('state', {})).value
  assert.deepEqual(after.mainBotIds, [writer.id])
  assert.deepEqual(after.bots.map(bot => bot.id), [writer.id])
})

test('a Main Bot moves to the front and the others keep their order', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const reader = (await call('create-bot', { name: 'Reader' })).value
  assert.deepEqual((await call('set-main', { id: writer.id, main: true })).value.mainBotIds, [chief, writer.id])
  assert.deepEqual((await call('set-main', { id: writer.id, main: true, primary: true })).value.mainBotIds, [writer.id, chief])
  assert.deepEqual((await call('set-main', { id: reader.id, main: true })).value.mainBotIds, [writer.id, chief, reader.id])
  // Replacing a Main Bot that is not first keeps its place; one already a Main Bot moves into it.
  assert.deepEqual((await call('set-main', { id: reader.id, main: true, replace: chief })).value.mainBotIds, [writer.id, reader.id])
  assert.deepEqual((await call('set-main', { id: writer.id, main: false })).value.mainBotIds, [reader.id])
})

test('set-main keeps one Main Bot and replaces only a Main Bot', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const reader = (await call('create-bot', { name: 'Reader' })).value
  assert.equal((await call('set-main', { id: chief, main: false })).ok, false)
  assert.equal((await call('set-main', { id: writer.id, main: true, replace: reader.id })).ok, false)
  assert.equal((await call('set-main', { id: 'nope', main: true })).ok, false)
  assert.equal((await call('set-main', { id: reader.id, main: false })).ok, true)
  assert.deepEqual((await call('state', {})).value.mainBotIds, [chief])
})

test('a hidden Bot made Main Bot shows again, and a replaced Chief drops its held greeting', async (t) => {
  const { call, stop, sent } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  await call('set-flags', { id: writer.id, hidden: true })
  await settle()
  const greeted = sent.length
  const team = (await call('set-main', { id: writer.id, main: true, replace: chief })).value
  assert.equal(team.bots.find(bot => bot.id === writer.id).hidden, undefined)
  assert.equal(team.bots.find(bot => bot.id === chief).waiting, undefined)
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await settle()
  assert.equal(sent.length, greeted)
})
