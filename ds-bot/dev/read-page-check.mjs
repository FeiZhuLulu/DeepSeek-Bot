// Runs the Bot browser reader (READ_PAGE_SCRIPT) on pages in headless Chrome and prints
// the time it took, the sizes, and the first lines of the text, as read_browser would get
// them. Quicker than the Desktop for working on the reader and for timing real sites.
//   node dev/read-page-check.mjs [--lines 40] [--out dir] [--chrome path] <url>...
// playwright-core comes from the deepseek-harness checkout next to ds-bot (DSH_HARNESS).
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import '../test/harness-resolve.mjs'
import { READ_PAGE_SCRIPT } from '../src/client/read-page.js'

// After the resolve hook above: browser.js imports @deepseek-ai/dsh-tools.
const { pageText } = await import('../src/host/browser.js')

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(name)
  if (at === -1) return fallback
  const [value] = args.splice(at, 2).slice(1)
  return value
}
const lines = Number(option('--lines', 40))
const outDir = option('--out')
const chrome = option('--chrome', '/usr/bin/google-chrome')
if (args.length === 0) {
  console.error('usage: node dev/read-page-check.mjs [--lines 40] [--out dir] [--chrome path] <url>...')
  process.exit(2)
}

const harness = resolve(process.env.DSH_HARNESS ?? join(import.meta.dirname, '..', '..', 'deepseek-harness'))
const require = createRequire(join(harness, 'package.json'))
const { chromium } = require(require.resolve('playwright-core', { paths: [join(harness, 'node_modules', '.pnpm', 'node_modules')] }))
if (outDir) mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({ executablePath: chrome, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
for (const [index, url] of args.entries()) {
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 })
  await page.waitForTimeout(1500)
  const started = Date.now()
  const read = await page.evaluate(READ_PAGE_SCRIPT)
  const ms = Date.now() - started
  const text = pageText(read)
  console.log(`\n=== ${url}`)
  console.log(`read in ${ms} ms (walk ${read.stats?.ms} ms); ${read.text.length} characters, ${read.items.length} links and controls, ${read.stats?.nodes} nodes, ${read.stats?.frames} frames${read.truncated ? `; cut: ${read.truncated}` : ''}`)
  console.log(read.text.split('\n').slice(0, lines).join('\n'))
  if (outDir) {
    writeFileSync(join(outDir, `${String(index + 1).padStart(2, '0')}-read.json`), JSON.stringify({ url, ms, ...read }, null, 2))
    writeFileSync(join(outDir, `${String(index + 1).padStart(2, '0')}-tool-result.txt`), text)
  }
}
await browser.close()
