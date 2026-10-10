// Walk the Bot browser in a running Desktop window (launch.mts) and screenshot each step:
// the empty panel, a page, per-Bot cookies (cookie-page.mjs on 8791), a Bot reading its
// page through read_browser (the mock model answers "看网页"), and the Windows caption.
// Usage: node browser-check.mjs <dsh-repo> <out-dir> [cdp-port=9422]
// COOKIE_PORT is the cookie page's port (default 8791; desktop.sh starts one on 88n3).
// Size the window first with window-size.mjs. A CDP screenshot of the app window draws
// webview guests at a wrong offset, so with SHOT_DISPLAY (the Xvfb display, e.g. :99,
// plus XAUTHORITY) the shots grab the screen with ffmpeg instead.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import simulateWindowsCaption from './simulate-windows-caption.mjs'

const [repo, outDir, port = '9422'] = process.argv.slice(2)
if (!repo || !outDir) {
  console.error('usage: node browser-check.mjs <dsh-repo> <out-dir> [cdp-port]')
  process.exit(2)
}
const require = createRequire(join(resolve(repo), 'package.json'))
const { chromium } = require(require.resolve('playwright-core', { paths: [join(resolve(repo), 'node_modules', '.pnpm', 'node_modules')] }))
mkdirSync(outDir, { recursive: true })
const cookiePort = process.env.COOKIE_PORT ?? '8791'

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('dsh-app://app/'))
if (!page) throw new Error('no Desktop app window')

const failures = []
let shot = 0
const capture = async (name) => {
  const path = join(outDir, `${String(++shot).padStart(2, '0')}-${name}.png`)
  const display = process.env.SHOT_DISPLAY
  // Off every titled control, so no tooltip lands in the shot.
  await page.mouse.move(100, 400)
  await page.waitForTimeout(300)
  if (display) {
    // The window sits at the screen's top-left; its outer size includes the menu bar.
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
const openChat = async (name) => {
  // A row's label adds its status after a comma ("Temp, Unread activity").
  await page.locator(`.bt-row[aria-label="${name}"], .bt-row[aria-label^="${name}, "]`).first().click()
  await page.waitForTimeout(900)
}
const address = page.locator('.bt-browser-address input[aria-label="Address"]')
// The panel says the page is up once the guest is on screen and the bar stops loading.
const settled = () => page.waitForFunction(() => document.querySelector('.bt-browser-frame[data-guest]') && !document.querySelector('.bt-browser-progress'), undefined, { timeout: 30_000 })
const go = async (text) => {
  await address.click()
  await address.fill(text)
  await address.press('Enter')
  await page.waitForTimeout(400)
  await settled()
  await page.waitForTimeout(1200)
}
// The visible guest is the open panel's active tab; every webview keeps its own
// storage partition, so reading it answers for its Bot.
const guestText = (script = 'document.body.innerText') => page.evaluate(code =>
  [...document.querySelectorAll('webview[data-bt-browser]')].find(view => view.style.visibility === 'visible')?.executeJavaScript(code), script)

// Start from empty panels: drop the saved addresses and reload the window. Cookies stay
// in each Bot's partition.
await page.evaluate(() => { localStorage.removeItem('ds-bot.browser.v2'); localStorage.removeItem('ds-bot.browser.v1') })
await page.reload()
await page.locator('.bt-row').first().waitFor({ timeout: 30_000 })
await page.waitForTimeout(1500)

await openChat('Writer')
// The browser lives in the Bot's panel now: details first, then the globe up top.
await page.locator('.bt-pill').click()
await page.waitForTimeout(700)
check(await page.locator('.bt-panel button[aria-label="Open browser"]').count() === 1, 'the Writer details panel has a browser button')
await page.locator('.bt-panel button[aria-label="Open browser"]').click()
await page.waitForTimeout(700)
await capture('writer-empty')
check(await page.locator('.bt-panel[data-view="browser"]').count() === 1, 'the browser view opens')

await go('example.com')
await capture('writer-example')
check(/Example Domain/.test(await guestText('document.title') ?? ''), 'Writer\'s browser shows example.com')

await go(`localhost:${cookiePort}/#Writer`)
check(/bot=Writer/.test(await guestText() ?? ''), 'Writer\'s page set its cookie')
await capture('writer-cookie')

await openChat('Coder')
// Coder has no tabs yet, so the panel follows the main view to Coder's details;
// the globe then opens its browser view. A Bot with tabs comes back in the
// browser view directly.
check(await page.locator('.bt-panel .bt-drawer-name').first().textContent() === 'Coder', 'the open panel follows the main view to Coder')
if (await page.locator('.bt-panel[data-view="browser"]').count() === 0) {
  await page.locator('.bt-panel button[aria-label="Open browser"]').click()
  await page.waitForTimeout(700)
}
check(await page.locator('.bt-panel[data-view="browser"][aria-label="Coder\'s browser"]').count() === 1, 'Coder\'s browser view opens')
await capture('coder-empty')
await go(`localhost:${cookiePort}/`)
const coderText = await guestText() ?? ''
check(/No cookies here/.test(coderText), `Coder's browser does not see Writer's cookie (${coderText.split('\n').at(-1)})`)
await capture('coder-cookie')

await openChat('Writer')
await page.waitForTimeout(600)
if (await page.locator('.bt-panel[data-view="browser"]').count() === 0) {
  await page.locator('.bt-panel button[aria-label="Open browser"]').click()
  await page.waitForTimeout(700)
}
check(/bot=Writer/.test(await guestText() ?? ''), 'Writer\'s page is still there after switching back')
await go('example.com')
const composer = page.locator('[contenteditable="true"], textarea').last()
await composer.click()
await page.keyboard.type('看网页')
await page.keyboard.press('Enter')
const read = await page.getByText('我看了你开的页面', { exact: false }).last().waitFor({ timeout: 30_000 }).then(() => true, () => false)
check(read, 'Writer reads its page with read_browser')
await page.waitForTimeout(1200)
await capture('writer-read')

await simulateWindowsCaption(page)
await capture('windows-caption-browser')
const top = await page.evaluate(() => document.querySelector('.bt-panel')?.getBoundingClientRect().top)
check(top >= 40, `the browser panel starts below the Windows caption (top ${top})`)
// The pill folds the browser back into the details view of the same panel.
await page.locator('.bt-pill').click()
await page.waitForTimeout(700)
check(await page.locator('.bt-panel[data-view="browser"]:not([data-leaving])').count() === 0, 'the pill folds the browser into the details view')
const drawerTop = await page.evaluate(() => document.querySelector('.bt-panel')?.getBoundingClientRect().top)
check(drawerTop >= 40, `the details view starts below the Windows caption (top ${drawerTop})`)
await capture('windows-caption-details')
// With tabs on the strip the drawer's own close button steps aside; Escape closes.
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
check(await page.locator('.bt-panel:not([data-leaving])').count() === 0, 'Escape closes the panel')
await page.evaluate(() => {
  delete document.documentElement.dataset.windowsTitlebar
  document.documentElement.style.removeProperty('--dsh-windows-titlebar-height')
  document.querySelector('[data-caption-sim]')?.remove()
})

await browser.close()
console.log(failures.length ? `browser check: ${failures.length} failed` : 'browser check: all passed')
process.exitCode = failures.length ? 1 : 0
