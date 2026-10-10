// Check the Bot browser reader in a running Desktop window (launch.mts): load the sample
// pages (dev/read-pages.mjs) and real sites in one Bot's browser, run the reader in the
// webview and time it, check what it reads, and ask the mock model "看网页结构" so the
// chat shows what read_browser returned. Writes screenshots and each read (JSON and the
// tool text) to <out-dir>.
//   node read-check.mjs <dsh-repo> <out-dir> [cdp-port=9422] [pages-port=8833] [bot=Chief] [--offline]
// Size the window first with window-size.mjs. Set SHOT_DISPLAY (the Xvfb display) and
// XAUTHORITY to grab the screen: a CDP screenshot draws webview guests at a wrong offset.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import '../../test/harness-resolve.mjs'
import { READ_PAGE_SCRIPT } from '../../src/client/read-page.js'

// After the resolve hook above: browser.js imports @deepseek-ai/dsh-tools.
const { pageText } = await import('../../src/host/browser.js')

const offline = process.argv.includes('--offline')
const [repo, outDir, port = '9422', pagesPort = '8833', botName = 'Chief'] = process.argv.slice(2).filter(arg => arg !== '--offline')
if (!repo || !outDir) {
  console.error('usage: node read-check.mjs <dsh-repo> <out-dir> [cdp-port] [pages-port] [bot] [--offline]')
  process.exit(2)
}
const require = createRequire(join(resolve(repo), 'package.json'))
const { chromium } = require(require.resolve('playwright-core', { paths: [join(resolve(repo), 'node_modules', '.pnpm', 'node_modules')] }))
mkdirSync(outDir, { recursive: true })

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('dsh-app://app/'))
if (!page) throw new Error('no Desktop app window')

const failures = []
let shot = 0
const capture = async (name) => {
  const path = join(outDir, `${String(++shot).padStart(2, '0')}-${name}.png`)
  const display = process.env.SHOT_DISPLAY
  await page.mouse.move(100, 400)
  await page.waitForTimeout(300)
  if (display) {
    const size = await page.evaluate(() => [window.outerWidth, window.outerHeight])
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'x11grab', '-video_size', size.join('x'), '-i', `${display}+0,0`, '-frames:v', '1', path])
  } else {
    await page.screenshot({ path })
  }
  console.log(path)
}
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`)
  if (!ok) failures.push(message)
}

const address = page.locator('.bt-browser-address input[aria-label="Address"]')
const settled = () => page.waitForFunction(() => document.querySelector('.bt-browser-frame[data-guest]') && !document.querySelector('.bt-browser-progress'), undefined, { timeout: 45_000 })
const go = async (text) => {
  await address.click()
  await address.fill(text)
  await address.press('Enter')
  await page.waitForTimeout(400)
  await settled()
  await page.waitForTimeout(2000)
}
// The reader as the window runs it: executeJavaScript in the panel's visible webview.
const readGuest = async (name) => {
  const started = Date.now()
  const read = await page.evaluate(code =>
    [...document.querySelectorAll('webview[data-bt-browser]')].find(view => view.style.visibility === 'visible')?.executeJavaScript(code), READ_PAGE_SCRIPT)
  const ms = Date.now() - started
  writeFileSync(join(outDir, `${name}-read.json`), JSON.stringify({ ms, ...read }, null, 2))
  writeFileSync(join(outDir, `${name}-tool-result.txt`), pageText(read))
  console.log(`     ${name}: ${ms} ms (walk ${read.stats.ms} ms), ${read.text.length} characters, ${read.items.length} links and controls, ${read.stats.nodes} nodes${read.truncated ? `, cut: ${read.truncated}` : ''}`)
  return { ms, read }
}
// Resolves once one more reply carries the marker than before the question.
const ask = async (text, marker) => {
  const replies = page.getByText(marker, { exact: false })
  const before = await replies.count()
  const composer = page.locator('[contenteditable="true"], textarea').last()
  await composer.click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  return replies.nth(before).waitFor({ timeout: 45_000 }).then(() => true, () => false)
}
// The newest reply, scrolled to its top so the shot shows the start of the result.
const showReply = () => page.evaluate(() => {
  const fences = [...document.querySelectorAll('pre')]
  fences.at(-1)?.scrollIntoView({ block: 'start' })
})

// The sidebar shows rows or tiles; a label adds the role and status after commas.
await page.locator([`.bt-row`, `.bt-tile`].flatMap(kind => [`${kind}[aria-label="${botName}"]`, `${kind}[aria-label^="${botName}, "]`]).join(', ')).first().click()
await page.waitForTimeout(900)
// The browser is a view of the Bot's panel now: details first, then the globe up top.
if (await page.locator('.bt-panel').count() === 0) {
  await page.locator('.bt-pill').click()
  await page.waitForTimeout(700)
}
if (await page.locator('.bt-panel[data-view="browser"]').count() === 0) await page.locator('.bt-panel button[aria-label="Open browser"]').click()
await page.waitForTimeout(700)
check(await page.locator('.bt-panel[data-view="browser"]').count() === 1, `${botName}'s browser view is open`)

await go(`127.0.0.1:${pagesPort}/`)
const sample = await readGuest('sample')
const text = sample.read.text
check(sample.read.format === 'markdown', 'the window reads Markdown')
check(text.includes('# Reader sample') && text.includes('## Lists'), 'headings keep their levels')
check(text.includes('- Fruit\n  3. Apple\n  4. Pear'), 'nested lists keep their order and indent')
check(text.includes('| Mon | Coder | Fix bug 7[#2] |') && text.includes('| Everyone |  | Retro |'), 'the table keeps its rows; row and column spans degrade')
check(text.includes('```js\nfunction greet(name) {\n  return `hi ${name}`\n}\n```'), 'the code block keeps its lines and language')
check(text.includes('### Bot: Chief') && text.includes('Leads the team.') && text.includes('Fallback text') && text.includes('Message[#'), 'the web component is read through its shadow root and slots')
check(text.includes('[iframe: Same-origin frame') && text.includes('Level one text with a frame link[#') && text.includes('[iframe: Nested frame') && text.includes('Level two text.'), 'same-origin frames are read, two levels deep')
check(text.includes(`[iframe (cross-origin, not readable): http://localhost:${pagesPort}/other.html]`) && !text.includes('CROSS-ORIGIN-TEXT'), 'the cross-origin frame is named, not read')
check(!/HIDDEN-/.test(text) && text.includes('but this child shows') && text.includes('More details'), 'hidden content stays out; a visible child of a hidden parent shows')
check(text.includes('Flex one\n\nFlex two'), 'flex items read as separate lines')
const secrets = JSON.stringify(sample.read)
check(!secrets.includes('SECRET-PASSWORD') && !secrets.includes('4111111111111111') && !secrets.includes('123456'), 'password, card and one-time-code values are not read')
check(sample.read.items.find(item => item.name === 'User')?.value === 'writer@example.com', 'an ordinary field reports its value')
await capture('sample-page')
check(await ask('看网页结构 70', '读到的结果'), `${botName} reads the sample page with read_browser`)
await page.waitForTimeout(1500)
await showReply()
await capture('sample-read')

await go(`127.0.0.1:${pagesPort}/big-table.html?rows=5000`)
const big = await readGuest('big-table')
check(big.ms < 2000 && big.read.text.includes('| 5000 | Item 5000 |'), `a 5000-row table reads whole in under 2 s (${big.ms} ms)`)

if (!offline) {
  const sites = [
    ['wikipedia', 'en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population'],
    ['mdn', 'developer.mozilla.org/en-US/docs/Web/API/Element/checkVisibility'],
    ['shoelace', 'shoelace.style/components/button'],
    ['github', 'github.com/denoland/deno'],
  ]
  for (const [name, url] of sites) {
    try {
      await go(url)
    } catch (error) {
      check(false, `${name} loads (${error.message.split('\n')[0]})`)
      continue
    }
    const site = await readGuest(name)
    check(site.ms < 2000 && site.read.text.length > 1000, `${name} reads in under 2 s (${site.ms} ms)`)
    if (name === 'wikipedia') {
      check(/\| Location \| Population \|/.test(site.read.text), 'the Wikipedia table reads as a Markdown table')
      await capture('wikipedia-page')
      check(await ask('看网页结构 50', '读到的结果'), `${botName} reads Wikipedia with read_browser`)
      await page.waitForTimeout(1500)
      await showReply()
      await capture('wikipedia-read')
    }
  }
}

await browser.close()
console.log(failures.length ? `read check: ${failures.length} failed` : 'read check: all passed')
process.exitCode = failures.length ? 1 : 0
