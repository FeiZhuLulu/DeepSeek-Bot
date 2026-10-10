// Shared helpers for the Desktop and Web check scripts: playwright-core comes from the
// deepseek-harness checkout (ds-bot installs no browser tooling of its own).
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

export function playwright(repo) {
  const root = resolve(repo)
  const require = createRequire(join(root, 'package.json'))
  return require(require.resolve('playwright-core', { paths: [join(root, 'node_modules', '.pnpm', 'node_modules')] }))
}

export const sleep = ms => new Promise(done => setTimeout(done, ms))

// The dsh Desktop app window over the renderer debugging port. Retries until `timeoutMs`,
// since the port opens well before the app page loads.
export async function connectApp(repo, port, timeoutMs = 0) {
  const { chromium } = playwright(repo)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let browser
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('dsh-app://app/'))
      if (page) return { browser, page }
      await browser.close()
    } catch (error) {
      await browser?.close().catch(() => {})
      if (Date.now() >= deadline) throw error
    }
    if (Date.now() >= deadline) throw new Error(`no Desktop app window on port ${port}`)
    await sleep(1000)
  }
}

// The Bot team is up once the sidebar shows a Bot: the Main Bot's tile (created on first
// load) or a row.
export const waitTeam = (page, timeout = 60_000) => page.locator('.bt-tile, .bt-row').first().waitFor({ timeout })

// With `display` (an Xvfb display plus XAUTHORITY in the environment), grab the screen:
// a CDP screenshot draws webview guests at a wrong offset. The window sits at the top-left
// and its outer size includes the menu bar.
export async function capture(page, path, display) {
  await page.mouse.move(100, 400)
  await page.waitForTimeout(300)
  if (display) {
    const size = await page.evaluate(() => [window.outerWidth, window.outerHeight])
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'x11grab', '-draw_mouse', '0', '-video_size', size.join('x'), '-i', `${display}+0,0`, '-frames:v', '1', path])
  } else {
    await page.screenshot({ path })
  }
  console.log(path)
}
