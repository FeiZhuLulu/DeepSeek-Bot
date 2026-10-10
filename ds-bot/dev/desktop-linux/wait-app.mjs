// Wait until a Desktop started by desktop.sh shows the Bot team.
// Usage: node wait-app.mjs <dsh-repo> <renderer-port> [timeout-seconds=240]
import { connectApp, waitTeam } from './lib.mjs'

const [repo, port, seconds = '240'] = process.argv.slice(2)
if (!repo || !port) {
  console.error('usage: node wait-app.mjs <dsh-repo> <renderer-port> [timeout-seconds]')
  process.exit(2)
}
const started = Date.now()
const timeout = Number(seconds) * 1000
const { browser, page } = await connectApp(repo, port, timeout)
await waitTeam(page, Math.max(timeout - (Date.now() - started), 5000))
console.log(`desktop app ready in ${Math.round((Date.now() - started) / 1000)} s`)
await browser.close()
