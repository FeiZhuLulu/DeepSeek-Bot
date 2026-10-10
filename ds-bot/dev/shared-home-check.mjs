// Web and Desktop on one DSH_HOME: does either dsh lose the other's team changes?
// Start both on the same data first (desktop.sh's files are named desktop*, so they sit
// next to a Web bench), Web first, as a user would:
//
//   dev/bench.sh desktop-share 3160 8860 reset
//   SLOT=6 dev/desktop-linux/desktop.sh share reset
//   node dev/shared-home-check.mjs share 3160 <dsh-repo> 9560
//
// Both ends load the team, then each creates a Bot and messages it, in turns. The check
// passes when every Bot an end reported as created is still in state.json, the team has
// one Main Bot, and each end either saved its change or refused it with a message.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectApp, sleep } from './desktop-linux/lib.mjs'

const [name, webPort, repo, rendererPort] = process.argv.slice(2)
if (!name || !webPort || !repo || !rendererPort) {
  console.error('usage: node dev/shared-home-check.mjs <desktop-name> <web-port> <dsh-repo> <renderer-port>')
  process.exit(2)
}
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const HOME = join(ROOT, `.dsh-test-desktop-${name}`)
const saved = () => JSON.parse(readFileSync(join(HOME, 'bot', 'state.json'), 'utf8'))
const names = team => Object.values(team.bots).map(bot => bot.name).sort()
const mainNames = team => team.mainBotIds.map(id => team.bots[id]?.name ?? id)

const log = readFileSync(join(HOME, 'web.log'), 'utf8')
const login = log.match(new RegExp(`http://127\\.0\\.0\\.1:${webPort}/\\?token=[^\\s]+`))?.[0]
if (!login) throw new Error('no login URL in web.log')
const cookie = (await fetch(login, { redirect: 'manual' })).headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
const web = (endpoint, payload = {}) => fetch(`http://127.0.0.1:${webPort}/api/bot`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ endpoint, payload }),
}).then(response => response.json())

const { browser, page } = await connectApp(repo, rendererPort, 60_000)
const desktop = (endpoint, payload = {}) => page.evaluate(([e, p]) => fetch('api/bot', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: e, payload: p }),
}).then(response => response.json()), [endpoint, payload])
const ends = { web, desktop }

const created = []
const refused = []
const report = (label) => {
  const team = saved()
  console.log(`${label}: state.json has ${names(team).join(', ') || 'no Bots'} (Main: ${mainNames(team).join(', ')}, revision ${team.revision})`)
}
const viewOf = async (end) => {
  const result = await ends[end]('state', {})
  if (!result.ok) return `error: ${result.error?.message}`
  return `${result.value.bots.map(bot => bot.name).sort().join(', ')}${result.value.readOnly ? ` (read-only: ${result.value.readOnly})` : ''}`
}

// Each end loads (and, on a new team, bootstraps) its team.
for (const end of ['desktop', 'web']) console.log(`${end} sees: ${await viewOf(end)}`)
await sleep(2000)
report('after both loaded')

for (const [end, botName] of [['web', 'WebBot'], ['desktop', 'DeskBot'], ['web', 'WebBot2']]) {
  const result = await ends[end]('create-bot', { name: botName })
  if (result.ok) {
    created.push(botName)
    console.log(`${end} created ${botName}`)
    const sent = await ends[end]('send', { sessionId: result.value.id, text: '你好' })
    console.log(`${end} messaged ${botName}: ${sent.ok ? 'ok' : sent.error?.message}`)
  } else {
    refused.push(`${end}: ${result.error?.message}`)
    console.log(`${end} refused ${botName}: ${result.error?.message}`)
  }
  await sleep(4000)
  report(`after ${end} created ${botName}`)
}
for (const end of ['desktop', 'web']) console.log(`${end} sees: ${await viewOf(end)}`)
await browser.close()

const team = saved()
const lost = created.filter(botName => !names(team).includes(botName))
const failures = []
if (lost.length > 0) failures.push(`lost Bots: ${lost.join(', ')}`)
if (team.mainBotIds.length !== 1) failures.push(`Main Bots: ${mainNames(team).join(', ') || 'none'}`)
console.log(failures.length === 0 ? `shared home: no lost updates (${refused.length} refused)` : `shared home: FAILED, ${failures.join('; ')}`)
process.exitCode = failures.length === 0 ? 0 : 1
