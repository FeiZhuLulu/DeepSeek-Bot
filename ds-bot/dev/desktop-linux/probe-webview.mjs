// Feasibility probe for the Desktop Bot browser: a plugin-side webview per Bot, read through
// executeJavaScript. Runs inside the dsh Desktop renderer through the debugging port.
export default async function (page) {
  const result = await page.evaluate(async () => {
    const bridge = globalThis.dshDesktop?.browser
    if (bridge === undefined) return { error: 'dshDesktop.browser is unavailable' }
    const open = async (botId, url, box) => {
      const { lease, partition } = await bridge.acquire(`bot:${botId}`)
      const view = document.createElement('webview')
      view.dataset.probe = botId
      view.setAttribute('partition', partition)
      view.setAttribute('src', `about:blank#${lease}`)
      Object.assign(view.style, { position: 'fixed', zIndex: 99, border: '1px solid #888', background: '#fff', ...box })
      const ready = new Promise(resolve => view.addEventListener('dom-ready', resolve, { once: true }))
      document.body.append(view)
      await ready
      const loaded = new Promise(resolve => view.addEventListener('did-stop-loading', resolve, { once: true }))
      await view.loadURL(url)
      await loaded
      return { view, partition }
    }
    const read = view => view.executeJavaScript(`(() => {
      const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
      const items = [...document.querySelectorAll('a[href], button, input, textarea, select, h1, h2, h3, [role=button]')]
        .filter(visible).slice(0, 12).map((el, i) => ({ ref: 'e' + (i + 1), tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || undefined, name: (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || '').trim().slice(0, 60),
          href: el.href || undefined }))
      return { url: location.href, title: document.title, text: document.body.innerText.slice(0, 400), items }
    })()`)
    const started = performance.now()
    const a = await open('probe-a', 'https://github.com/deepseek-ai', { right: '16px', bottom: '96px', width: '560px', height: '340px' })
    const b = await open('probe-b', 'https://developer.mozilla.org/en-US/', { right: '600px', bottom: '96px', width: '420px', height: '340px' })
    const loadMs = Math.round(performance.now() - started)
    await a.view.executeJavaScript(`document.cookie = 'dsb_probe=a; path=/'`)
    const t0 = performance.now()
    const readA = await read(a.view)
    const readMs = Math.round(performance.now() - t0)
    const readB = await read(b.view)
    await b.view.loadURL('https://github.com/')
    const cookieInB = await b.view.executeJavaScript('document.cookie.includes("dsb_probe=a")')
    await b.view.loadURL('https://developer.mozilla.org/en-US/')
    await new Promise(resolve => setTimeout(resolve, 2500))
    return { loadMs, readMs, partitions: [a.partition, b.partition], cookieInB, readA, readB: { url: readB.url, title: readB.title, items: readB.items.slice(0, 4) } }
  })
  console.log(JSON.stringify(result, null, 1))
}
