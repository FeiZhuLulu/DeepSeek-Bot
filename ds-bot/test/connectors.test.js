import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { signIn } from '../src/host/connectors.js'
import { fakeContext } from './fake-ctx.js'

const fresh = () => `ghp_${randomBytes(16).toString('hex')}`
const answer = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })

test('signIn asks GitHub who owns the token', async () => {
  const token = fresh()
  let seen
  const user = await signIn(token, { api: 'https://gh.test/', fetch: async (url, init) => { seen = { url, init }; return answer(200, { login: 'octo' }) } })
  assert.deepEqual(user, { login: 'octo' })
  assert.equal(seen.url, 'https://gh.test/user')
  assert.equal(seen.init.headers.Authorization, `Bearer ${token}`)
  await assert.rejects(signIn(token, { fetch: async () => answer(401, {}) }), /did not accept/)
  await assert.rejects(signIn(token, { fetch: async () => answer(500, {}) }), /GitHub answered 500/)
  await assert.rejects(signIn(token, { fetch: async () => { throw new Error(`boom ${token}`) } }), /^Error: Could not reach GitHub$/)
})

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const teamHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-connectors-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  return home
}

// A loader that hands out a fake MCP client and records each mount.
function setup({ fail = false, github = { api: 'https://gh.test' } } = {}) {
  const home = teamHome()
  const mounts = []
  const plugin = { name: 'mcp-client', apply() {} }
  const loader = {
    import: async name => { assert.equal(name, '@deepseek-ai/dsh-mcp-client'); return { default: plugin } },
    unwrapExports: exports => exports.default,
  }
  const ctx = fakeContext({ services: { loader } })
  ctx.plugin = (given, config) => {
    assert.equal(given, plugin)
    const mount = { config, disposed: false }
    mounts.push(mount)
    return {
      await: async () => { if (fail) throw new Error(`refused ${config.headers.Authorization}`) },
      dispose: () => { mount.disposed = true },
    }
  }
  capture(ctx)
  apply(ctx, { home, github })
  return { ctx, home, mounts }
}

function capture(ctx) {
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
}

// Calls the /api/bot route the way the client does.
async function call(ctx, endpoint, payload) {
  const response = await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
  return response.json()
}

test('connecting saves the token, kept out of every Bot shell, and mounts GitHub MCP; disconnecting undoes both', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async () => answer(200, { login: 'octo' })
  const { ctx, home, mounts } = setup()
  t.after(() => { ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  const token = fresh()

  const before = await call(ctx, 'state', {})
  assert.deepEqual(before.value.connectors, [{ id: 'github', name: 'GitHub', state: 'off', account: null }])

  const connected = await call(ctx, 'connector-connect', { id: 'github', token: ` ${token} ` })
  assert.equal(connected.ok, true, JSON.stringify(connected))
  assert.deepEqual(connected.value, [{ id: 'github', name: 'GitHub', state: 'ready', account: 'octo' }])
  assert.equal(mounts.length, 1)
  assert.deepEqual(mounts[0].config, {
    transport: 'streamable-http',
    serverName: 'github',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: { Authorization: `Bearer ${token}`, 'X-MCP-Toolsets': 'context,repos,issues,pull_requests' },
    failOnStartupError: true,
  })
  const state = await call(ctx, 'state', {})
  assert.deepEqual(state.value.secrets.map(secret => [secret.name, secret.scope]), [['GITHUB_TOKEN', []]])
  assert.ok(!JSON.stringify(state).includes(token))
  assert.ok(!readFileSync(join(home, 'state.json'), 'utf8').includes(token))

  const off = await call(ctx, 'connector-disconnect', { id: 'github' })
  assert.deepEqual(off.value, [{ id: 'github', name: 'GitHub', state: 'off', account: null }])
  assert.equal(mounts[0].disposed, true)
  assert.deepEqual((await call(ctx, 'state', {})).value.secrets, [])
})

test('a token GitHub refuses is not saved', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async () => answer(401, {})
  const { ctx, home, mounts } = setup()
  t.after(() => { ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  const result = await call(ctx, 'connector-connect', { id: 'github', token: fresh() })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /did not accept/)
  assert.equal(mounts.length, 0)
  assert.deepEqual((await call(ctx, 'state', {})).value.secrets, [])
})

test('a failed MCP connection shows the error without the token, and Try again mounts again', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async () => answer(200, { login: 'octo' })
  const { ctx, home, mounts } = setup({ fail: true })
  t.after(() => { ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  const token = fresh()
  const result = await call(ctx, 'connector-connect', { id: 'github', token })
  const [github] = result.value
  assert.equal(github.state, 'error')
  assert.ok(!github.error.includes(token), github.error)
  assert.match(github.error, /\[secret:GITHUB_TOKEN\]/)
  await call(ctx, 'connector-retry', { id: 'github' })
  assert.equal(mounts.length, 2)
})

test('deleting GITHUB_TOKEN on the Secrets page unmounts GitHub', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async () => answer(200, { login: 'octo' })
  const { ctx, home, mounts } = setup()
  t.after(() => { ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await call(ctx, 'connector-connect', { id: 'github', token: fresh() })
  await call(ctx, 'secret-delete', { name: 'GITHUB_TOKEN' })
  const state = await call(ctx, 'state', {})
  assert.equal(mounts[0].disposed, true)
  assert.equal(state.value.connectors[0].state, 'off')
})

test('github: false hides the connector', async (t) => {
  const home = teamHome()
  const ctx = fakeContext()
  capture(ctx)
  apply(ctx, { home, github: false })
  t.after(() => { ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  assert.deepEqual((await call(ctx, 'state', {})).value.connectors, [])
})

test('a GitHub address without https refuses to send the token', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  let asked = false
  globalThis.fetch = async () => { asked = true; return answer(200, { login: 'octo' }) }
  const { ctx, home, mounts } = setup({ github: { url: 'http://mcp.test/', api: 'https://gh.test' } })
  t.after(() => { ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  const refused = await call(ctx, 'connector-connect', { id: 'github', token: fresh() })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /https/)
  assert.equal(asked, false)
  assert.equal(mounts.length, 0)
})
