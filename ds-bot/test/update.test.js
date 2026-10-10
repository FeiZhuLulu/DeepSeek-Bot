import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { cleanVersion, install, newer, sourceOf } from '../src/host/update.js'

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() }
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

// The update module alone, on a stub plugin manager and a scripted fetch.
function start({ source, registries, answers = {}, result = { application: 'restart-required' }, config = {}, profileDir }) {
  const fetched = []
  const installs = []
  const warnings = []
  globalThis.fetch = async (url) => {
    fetched.push(url)
    const answer = answers[url]
    if (answer === undefined) return { ok: false, status: 404, json: async () => ({}) }
    if (answer instanceof Error) throw answer
    return { ok: true, status: 200, json: async () => answer }
  }
  const pluginManager = {
    listBundles: async () => [{ name: 'other', source: 'other@^1.0.0' }, ...(source === undefined ? [] : [{ name: PKG.name, source }])],
    registries: async () => registries ?? { registry: null, fallbackRegistries: ['https://registry.npmmirror.com/'], resolved: 'https://registry.npmjs.org/' },
    installBundle: async (spec, options) => { installs.push([spec, options]); return typeof result === 'function' ? result() : result },
  }
  const rt = {
    ctx: { get: name => (name === 'pluginManager' ? pluginManager : name === 'profileContext' && profileDir ? { dir: profileDir } : undefined), effect() {} },
    config,
    warn: (...args) => warnings.push(args),
  }
  install(rt)
  return { rt, fetched, installs, warnings }
}

test('versions compare in semver order and lose their v and build metadata', () => {
  assert.equal(cleanVersion('v1.2.3+build.5'), '1.2.3')
  assert.equal(cleanVersion('latest'), null)
  assert.equal(newer('0.2.0', '0.1.9'), true)
  assert.equal(newer('0.10.0', '0.9.0'), true)
  assert.equal(newer('1.0.0', '1.0.0'), false)
  assert.equal(newer('1.0.0', '1.0.0-beta.2'), true)
  assert.equal(newer('1.0.0-beta.10', '1.0.0-beta.2'), true)
  assert.equal(newer('0.1.0', '0.2.0'), false)
})

test('the install source decides where a newer version is looked for', () => {
  assert.deepEqual(sourceOf('ds-bot@^0.1.0'), { kind: 'registry' })
  assert.deepEqual(sourceOf('@scope/ds-bot@latest'), { kind: 'registry' })
  // A profile's own dependency entry says the same without the package name.
  assert.deepEqual(sourceOf('^0.1.0'), { kind: 'registry' })
  assert.deepEqual(sourceOf('npm:ds-bot@^0.1.0'), { kind: 'registry' })
  assert.deepEqual(sourceOf('link:E:/项目库/My Bots/ds-bot'), { kind: 'path' })
  assert.deepEqual(sourceOf('/home/user/ds-bot'), { kind: 'path' })
  assert.deepEqual(sourceOf('github:FeiZhuLulu/DeepSeek-Bot#v0.1.0&path:/ds-bot'),
    { kind: 'git', owner: 'FeiZhuLulu', repo: 'DeepSeek-Bot', ref: 'v0.1.0', rest: ['path:/ds-bot'] })
  assert.deepEqual(sourceOf('git+https://github.com/FeiZhuLulu/DeepSeek-Bot.git#main'),
    { kind: 'git', owner: 'FeiZhuLulu', repo: 'DeepSeek-Bot', rest: [] })
  assert.deepEqual(sourceOf('https://example.com/ds-bot-0.1.0.tgz'), { kind: 'tarball' })
  assert.deepEqual(sourceOf(undefined), { kind: 'unknown' })
})

test('a registry install finds the newest version on the next registry and installs it from there', async () => {
  const { rt, fetched, installs } = start({
    source: `${PKG.name}@^${PKG.version}`,
    answers: {
      [`https://registry.npmjs.org/${PKG.name}/latest`]: new Error('offline'),
      [`https://registry.npmmirror.com/${PKG.name}/latest`]: { version: '9.0.0' },
    },
    result: { application: 'restart-required', version: '9.0.0' },
  })
  const view = await rt.updateCheck()
  assert.deepEqual(fetched, [`https://registry.npmjs.org/${PKG.name}/latest`, `https://registry.npmmirror.com/${PKG.name}/latest`])
  assert.equal(view.available, true)
  assert.equal(view.latest, '9.0.0')
  assert.equal(view.current, PKG.version)
  assert.equal(view.source, 'registry')
  assert.equal(view.notesUrl, 'https://github.com/FeiZhuLulu/DeepSeek-Bot/releases')
  assert.equal(rt.updateStart().phase, 'installing')
  await flush()
  assert.deepEqual(installs, [[`${PKG.name}@9.0.0`, { registry: 'https://registry.npmmirror.com/' }]])
  const done = await rt.updateCheck()
  assert.equal(done.phase, 'installed')
  assert.equal(done.installed, '9.0.0')
  assert.equal(done.available, false)
})

test('a private registry of pnpm\'s own is asked alone, and an answer stands for a while', async () => {
  const { rt, fetched } = start({
    source: `${PKG.name}@^${PKG.version}`,
    registries: { registry: null, fallbackRegistries: ['https://registry.npmmirror.com/'], resolved: 'https://npm.corp.example/' },
    answers: { [`https://npm.corp.example/${PKG.name}/latest`]: { version: PKG.version } },
  })
  const view = await rt.updateCheck()
  assert.equal(view.available, false)
  assert.deepEqual(fetched, [`https://npm.corp.example/${PKG.name}/latest`])
  await rt.updateCheck()
  assert.equal(fetched.length, 1)
  await rt.updateCheck({ fresh: true })
  assert.equal(fetched.length, 2)
})

test('a versioned GitHub install follows the latest release tag and keeps its path', async () => {
  const { rt, installs } = start({
    source: 'github:FeiZhuLulu/DeepSeek-Bot#v0.1.0&path:/ds-bot',
    answers: { 'https://api.github.com/repos/FeiZhuLulu/DeepSeek-Bot/releases/latest': { tag_name: 'v9.1.0' } },
  })
  const view = await rt.updateCheck()
  assert.equal(view.available, true)
  assert.equal(view.latest, '9.1.0')
  rt.updateStart()
  await flush()
  assert.deepEqual(installs, [['github:FeiZhuLulu/DeepSeek-Bot#v9.1.0&path:/ds-bot', {}]])
})

test('a linked checkout, an unversioned git install, or a disabled check never asks the network', async () => {
  for (const source of [`link:/work/${PKG.name}`, 'github:FeiZhuLulu/DeepSeek-Bot#main', undefined]) {
    const { rt, fetched } = start({ source })
    const view = await rt.updateCheck()
    assert.equal(view.available, false)
    assert.deepEqual(fetched, [])
    assert.throws(() => rt.updateStart(), /No DS Bot update/)
  }
  const { rt, fetched } = start({ source: `${PKG.name}@^${PKG.version}`, config: { updateCheck: false } })
  assert.equal((await rt.updateCheck({ fresh: true })).available, false)
  assert.deepEqual(fetched, [])
})

test('without a source from the plugin manager, the profile\'s own dependency entry decides', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-update-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { [PKG.name]: `^${PKG.version}` } }))
  const { rt } = start({
    profileDir: dir,
    answers: { [`https://registry.npmjs.org/${PKG.name}/latest`]: { version: '9.0.0' } },
  })
  const view = await rt.updateCheck()
  assert.equal(view.source, 'registry')
  assert.equal(view.available, true)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { [PKG.name]: 'link:/work/ds-bot' } }))
  assert.equal((await rt.updateCheck({ fresh: true })).source, 'path')
  rmSync(dir, { recursive: true, force: true })
})

test('a check that finds nothing clears the version a check before it found', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-update-'))
  const setSource = source => writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { [PKG.name]: source } }))
  setSource(`^${PKG.version}`)
  const latest = `https://registry.npmjs.org/${PKG.name}/latest`
  const answers = { [latest]: { version: '9.0.0' } }
  const { rt } = start({ profileDir: dir, answers })
  const offered = await rt.updateCheck()
  assert.equal(offered.available, true)
  assert.equal(offered.latest, '9.0.0')
  // The profile now links a local checkout: the old registry offer must go.
  setSource('link:/work/ds-bot')
  const linked = await rt.updateCheck({ fresh: true })
  assert.equal(linked.available, false)
  assert.equal(linked.latest, null)
  assert.throws(() => rt.updateStart(), /No DS Bot update/)
  // Back on the registry with no copy answering: the offer stays cleared.
  delete answers[latest]
  setSource(`^${PKG.version}`)
  const gone = await rt.updateCheck({ fresh: true })
  assert.equal(gone.available, false)
  assert.equal(gone.latest, null)
  rmSync(dir, { recursive: true, force: true })
})

test('a failed install reports why and can be tried again', async () => {
  let attempt = 0
  const { rt, installs } = start({
    source: `${PKG.name}@^${PKG.version}`,
    config: { updateRegistry: 'https://registry.example' },
    answers: { [`https://registry.example/${PKG.name}/latest`]: { version: '9.0.0' } },
    result: () => (++attempt === 1
      ? { application: 'failed', error: { code: 'incompatible-version', diagnostic: 'needs a newer DSH' } }
      : { application: 'restart-required', version: '9.0.0' }),
  })
  await rt.updateCheck()
  rt.updateStart()
  await flush()
  const failed = await rt.updateCheck()
  assert.equal(failed.phase, 'failed')
  assert.equal(failed.error, 'needs a newer DSH')
  assert.equal(failed.available, true)
  rt.updateStart()
  await flush()
  assert.equal((await rt.updateCheck()).phase, 'installed')
  assert.equal(installs.length, 2)
  assert.deepEqual(installs[0][1], { registry: 'https://registry.example/' })
})
