// Screenshot the dsh Desktop windows through the renderer debugging port.
// Usage: node shot.mjs <dsh-repo> <out-prefix> [cdp-port] [script.mjs]
// The optional script exports default async (page) => {} and runs before the capture.
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [repo, prefix, port = '9422', script] = process.argv.slice(2)
const require = createRequire(join(resolve(repo), 'package.json'))
const { chromium } = require(require.resolve('playwright-core', { paths: [join(resolve(repo), 'node_modules', '.pnpm', 'node_modules')] }))
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const pages = browser.contexts().flatMap(context => context.pages())
let index = 0
for (const page of pages) {
  const url = page.url()
  if (url.startsWith('devtools://')) continue
  if (script) await (await import(pathToFileURL(resolve(script)).href)).default(page)
  const path = `${prefix}-${index++}.png`
  await page.screenshot({ path })
  console.log(path, url.replace(/token=[^&]*/g, 'token=***'), await page.title())
}
await browser.close()
