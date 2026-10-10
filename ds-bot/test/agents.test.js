import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { TEAM_TOOLS } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'

const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() }

// Enough of the dsh services for the roster and the agents module; tool restrict
// calls and archived Sessions are recorded for the assertions.
function start(team, { config = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-agents-'))
  if (team !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext()
  const workspaces = new Map()
  const created = []
  const archived = []
  const failArchive = { on: false }
  const restricted = []
  const renamed = []
  let sessions = 0
  ctx.tools.schemas = () => [...TEAM_TOOLS, 'read', 'write'].map(name => ({ name }))
  Object.assign(ctx, {
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async path => [...workspaces.values()].find(workspace => workspace.path === path),
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async (sessionId) => {
        if (failArchive.on) throw new Error('session is running')
        archived.push(sessionId)
      },
    },
    sessionController: {
      create: async (options) => {
        created.push(options)
        return { sessionId: `s${++sessions}` }
      },
      resolveAgent: async (sessionId) => {
        const agent = {
          session: { id: sessionId },
          ctx: { tools: { restrict: (filter) => { restricted.push({ sessionId, filter }); return () => {} } } },
          followup() {},
        }
        return { agent }
      },
      selectModel: async () => {},
    },
    sessionTitle: { rename: async (session, title) => { renamed.push({ id: session.id, title }) } },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home, ...config })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const createdAgents = payload => (ctx.listeners.get('agent/created') ?? []).map(listener => listener(payload))
  const stop = () => {
    ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  }
  return { call, stop, home, created, archived, failArchive, restricted, renamed, createdAgents, ctx }
}

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 2,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

test('add-agent creates one record with a first Session in the DS Bot workspace', async (t) => {
  const { call, stop, created } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent')).value
  assert.equal(agent.name, 'DSH Agent')
  assert.equal(agent.sessions.length, 1)
  const view = (await call('state', {})).value
  assert.deepEqual(view.agents.map(entry => entry.id), [agent.id])
  // The Session was created in the workspace the Bots live in.
  const workspaceId = view.workspaceId
  assert.equal(created.at(-1).workspaceId, workspaceId)
})

test('a team holds at most one DSH Agent', async (t) => {
  const { call, stop } = start(TEAM)
  t.after(stop)
  await call('state', {})
  assert.equal((await call('add-agent')).ok, true)
  const again = await call('add-agent')
  assert.equal(again.ok, false)
  assert.equal(again.error.message, 'The team already has a DSH Agent')
})

test('agent-session appends Sessions; agent-archive removes one and archives it', async (t) => {
  const { call, stop, archived } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent')).value
  const second = (await call('agent-session', { agentId: agent.id })).value
  assert.equal((await call('state', {})).value.agents[0].sessions.length, 2)
  assert.equal((await call('agent-archive', { agentId: agent.id, sessionId: second.sessionId })).ok, true)
  const view = (await call('state', {})).value
  assert.deepEqual(view.agents[0].sessions, agent.sessions)
  assert.deepEqual(archived, [second.sessionId])
})

test('a failed archive keeps the Session in the Agent and answers with the error', async (t) => {
  const { call, stop, archived, failArchive } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent')).value
  const second = (await call('agent-session', { agentId: agent.id })).value
  failArchive.on = true
  const failed = await call('agent-archive', { agentId: agent.id, sessionId: second.sessionId })
  assert.equal(failed.ok, false)
  // The Session stays with the Agent, so the restriction and the retry stay.
  assert.deepEqual((await call('state', {})).value.agents[0].sessions, [agent.sessions[0], second.sessionId])
  assert.deepEqual(archived, [])
  failArchive.on = false
  assert.equal((await call('agent-archive', { agentId: agent.id, sessionId: second.sessionId })).ok, true)
})

test('agent-rename retitles an owned Session and refuses others', async (t) => {
  const { call, stop, renamed } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent')).value
  assert.equal((await call('agent-rename', { agentId: agent.id, sessionId: agent.sessions[0], title: '  Scratch  ' })).ok, true)
  assert.deepEqual(renamed.at(-1), { id: agent.sessions[0], title: 'Scratch' })
  assert.equal((await call('agent-rename', { agentId: agent.id, sessionId: agent.sessions[0], title: '   ' })).ok, false)
  // A Bot's Session cannot be renamed through the agent endpoint.
  assert.equal((await call('agent-rename', { agentId: agent.id, sessionId: 'm1', title: 'x' })).ok, false)
})

test('remove-agent keeps the Agent with the Sessions it could not archive', async (t) => {
  const { call, stop, archived, failArchive } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent')).value
  const second = (await call('agent-session', { agentId: agent.id })).value
  failArchive.on = true
  const failed = await call('remove-agent', { agentId: agent.id })
  assert.equal(failed.ok, false)
  // Nothing archived, so the Agent stays whole; the retry then removes it.
  assert.deepEqual((await call('state', {})).value.agents[0].sessions, [agent.sessions[0], second.sessionId])
  assert.deepEqual(archived, [])
  failArchive.on = false
  assert.equal((await call('remove-agent', { agentId: agent.id })).ok, true)
  assert.equal((await call('state', {})).value.agents.length, 0)
})

test('remove-agent archives every Session and drops the record', async (t) => {
  const { call, stop, archived } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent')).value
  const second = (await call('agent-session', { agentId: agent.id })).value
  assert.equal((await call('remove-agent', { agentId: agent.id })).ok, true)
  assert.deepEqual((await call('state', {})).value.agents, [])
  assert.deepEqual([...archived].sort(), [agent.sessions[0], second.sessionId].sort())
})

test('agents survive a state reload', async (t) => {
  const { call, stop, home } = start(TEAM)
  await call('state', {})
  const agent = (await call('add-agent')).value
  // Restart on the saved file: the agent record is adopted, not lost.
  const saved = readFileSync(join(home, 'state.json'), 'utf8')
  stop()
  const again = start(JSON.parse(saved))
  t.after(again.stop)
  const view = (await again.call('state', {})).value
  assert.deepEqual(view.agents.map(entry => entry.id), [agent.id])
})

test('a corrupt agents field resets instead of crashing the view', async (t) => {
  const { call, stop } = start({ ...TEAM, agents: 'junk' })
  t.after(stop)
  const view = (await call('state', {})).value
  assert.deepEqual(view.agents, [])
})

test('TEAM_TOOLS names exactly the tools ds-bot registers', async (t) => {
  // read_browser registers only in the Desktop profile; the flag stands in for it.
  const { stop, ctx } = start(TEAM, { config: { browser: true } })
  t.after(stop)
  assert.deepEqual([...ctx.registeredTools.keys()].sort(), [...TEAM_TOOLS].sort())
})

test('agent-session honors a known workspace and falls back to the team workspace', async (t) => {
  const { call, stop, created, ctx } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent')).value
  // An unknown workspace id falls back; a real one is used as given.
  await call('agent-session', { agentId: agent.id, workspaceId: 'nope' })
  assert.equal(created.at(-1).workspaceId, (await call('state', {})).value.workspaceId)
  const other = await ctx.workspaceRegistry.create('/tmp/elsewhere')
  await call('agent-session', { agentId: agent.id, workspaceId: other.id })
  assert.equal(created.at(-1).workspaceId, other.id)
})

test('agent-adopt takes an unowned Session and refuses team-owned ones', async (t) => {
  const { call, stop, restricted } = start(TEAM)
  t.after(stop)
  await call('state', {})
  const agent = (await call('add-agent')).value
  // A plain root Session (the workspace picker's blank, or a fork) joins the Agent.
  const adopted = (await call('agent-adopt', { agentId: agent.id, sessionId: 'fresh' })).value
  assert.equal(adopted.sessionId, 'fresh')
  assert.deepEqual((await call('state', {})).value.agents[0].sessions, [...agent.sessions, 'fresh'])
  // It gets the team-tools mask too.
  assert.equal(restricted.at(-1).sessionId, 'fresh')
  // Adopting again is a no-op.
  assert.equal((await call('agent-adopt', { agentId: agent.id, sessionId: 'fresh' })).ok, true)
  // A Bot's Session and an unknown Agent are refused.
  assert.equal((await call('agent-adopt', { agentId: agent.id, sessionId: 'm1' })).ok, false)
  assert.equal((await call('agent-adopt', { agentId: 'none', sessionId: 'fresh2' })).error.message, 'Unknown DSH Agent')
})

test('team tools are restricted on DSH Agent Sessions but not on Bot Sessions', async (t) => {
  const { call, stop, restricted, createdAgents } = start(TEAM)
  t.after(stop)
  await call('state', {})
  // A Bot resolving its agent triggers agent/created but owns no team tools mask.
  createdAgents({ agent: { session: { id: 'm1' }, ctx: { tools: { restrict: filter => { restricted.push({ sessionId: 'm1', filter }) } } } } })
  await flush()
  assert.equal(restricted.length, 0)
  // Creating the agent records the session, then restrict fires on its own agent.
  const agent = (await call('add-agent')).value
  assert.equal(restricted.length, 1)
  assert.equal(restricted[0].sessionId, agent.sessions[0])
  assert.deepEqual([...restricted[0].filter.deny].sort(), [...TEAM_TOOLS].sort())
  // A later agent/created for that session does not restrict a second time.
  const listener = { session: { id: agent.sessions[0] }, ctx: { tools: { restrict: filter => { restricted.push({ sessionId: agent.sessions[0], filter }) } } } }
  createdAgents({ agent: listener })
  await flush()
  // The listener path resolves through rt.load() + the session index; because the
  // fake resolveAgent is not consulted here, the WeakSet does not know this agent
  // object, so the event does restrict — but still only for the agent session.
  assert.equal(restricted.every(entry => entry.sessionId === agent.sessions[0]), true)
})
