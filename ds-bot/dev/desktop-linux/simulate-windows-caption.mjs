// Approximate the Windows Desktop window chrome on Linux: dsh's preload sets data-windows-titlebar
// and --dsh-windows-titlebar-height (apps/desktop/src/preload-windows.ts), and Electron draws the
// native minimize/maximize/close buttons over the top-right 40 px. The red boxes stand in for those
// native buttons and for the drag band, which neither paints nor takes clicks on Linux.
export default async function (page) {
  await page.evaluate(() => {
    const root = document.documentElement
    root.dataset.windowsTitlebar = ''
    root.style.setProperty('--dsh-windows-titlebar-height', '40px')
    document.querySelector('[data-caption-sim]')?.remove()
    const sim = document.createElement('div')
    sim.dataset.captionSim = ''
    sim.style.cssText = 'position:fixed;inset:0 0 auto;height:40px;z-index:2147483647;pointer-events:none;'
      + 'border-bottom:2px dashed rgba(220,38,38,.75);background:rgba(220,38,38,.06)'
    const buttons = document.createElement('div')
    buttons.style.cssText = 'position:absolute;top:0;right:0;width:138px;height:40px;display:flex;'
      + 'background:rgba(220,38,38,.18);outline:2px solid rgba(220,38,38,.85);font:14px system-ui;color:#991b1b'
    for (const glyph of ['—', '☐', '✕']) {
      const button = document.createElement('span')
      button.textContent = glyph
      button.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center'
      buttons.append(button)
    }
    const label = document.createElement('span')
    label.textContent = 'Windows caption: drag band + native buttons (40px)'
    label.style.cssText = 'position:absolute;top:11px;left:50%;transform:translateX(-50%);font:12px system-ui;color:#b91c1c'
    sim.append(buttons, label)
    document.body.append(sim)
  })
  await page.waitForTimeout(600)
  if (process.env.OPEN_DETAILS === '1') {
    await page.getByRole('button', { name: 'View conversation details' }).click()
    await page.waitForTimeout(800)
  }
}
