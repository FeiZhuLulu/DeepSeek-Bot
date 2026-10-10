import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { READ_LIMITS, READ_PAGE_SCRIPT, readPageScript } from '../src/client/read-page.js'

// jsdom comes from the deepseek-harness checkout next to ds-bot, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness')
const { JSDOM } = createRequire(join(harness, 'package.json'))('jsdom')

const PAGE = `<!doctype html><html lang="en"><head><title>Sample</title>
<meta name="description" content="About the sample">
<style>.gone{display:none} .ghost{visibility:hidden} .chip{display:inline-block} .folded{overflow-x:hidden;overflow-y:hidden}</style></head>
<body>
<h1>Sample <a href="#top">page</a></h1>
<p>Some <code>code</code> and a <a href="/docs">doc link</a>.<br>Next line.</p>
<ul><li>Fruit<ol start="3"><li>Apple</li><li>Pear <span class="chip">ripe</span><span class="chip">green</span></li></ol></li><li>Vegetables</li></ul>
<table><caption>Plan</caption>
<tr><th>Day</th><th>Who</th><th>Task</th></tr>
<tr><td rowspan="2">Mon</td><td>Writer</td><td>Draft | review</td></tr>
<tr><td>Coder</td><td>Fix</td></tr>
<tr><td colspan="2">All</td><td>Retro</td></tr>
</table>
<pre class="language-js">let a = 1
  indented()</pre>
<blockquote><p>Quoted one.</p><p>Quoted two.</p></blockquote>
<hr>
<p class="gone">HIDDEN-DISPLAY</p>
<p class="ghost">HIDDEN-VISIBILITY <span style="visibility: visible">shown child</span></p>
<div class="folded" data-zero>HIDDEN-FOLDED</div>
<details><summary>More</summary>HIDDEN-DETAILS</details>
<p><img alt="A dot"> <img src="x.png"> after.</p>
<div role="heading" aria-level="3">Aria heading</div>
<div id="host">LIGHT-UNSLOTTED<span slot="name">Chief</span></div>
<label for="user">User</label><input id="user" value="writer@example.com">
<input id="pw" type="password" value="SECRET-PASSWORD" aria-label="Password">
<input autocomplete="cc-number" value="SECRET-CARD" placeholder="Card">
<input name="otp" value="SECRET-OTP" placeholder="Code">
<label><input type="checkbox" checked> Remember</label>
<select aria-label="Color"><option>Red</option><option selected>Blue</option></select>
<button disabled>Send</button>
<textarea>DRAFT-IN-TEXTAREA</textarea>
<iframe id="same" title="Inner"></iframe>
<iframe id="cross" src="https://other.example/embed"></iframe>
<script>SCRIPT-TEXT</script>
</body></html>`

function makePage() {
  const dom = new JSDOM(PAGE, { url: 'https://example.com/sample', runScripts: 'outside-only', pretendToBeVisual: true })
  const { window } = dom
  // jsdom has no layout: every box is 100×20 unless marked data-zero.
  const layout = (frame) => {
    frame.Element.prototype.getBoundingClientRect = function () {
      const zero = this.hasAttribute('data-zero')
      return { width: zero ? 0 : 100, height: zero ? 0 : 20, top: 0, left: 0, right: 0, bottom: 0 }
    }
  }
  layout(window)
  const doc = window.document
  const host = doc.getElementById('host')
  host.attachShadow({ mode: 'open' }).innerHTML = '<style>.x{}</style><h3>Bot: <slot name="name">nobody</slot></h3><p><slot name="missing">Fallback</slot></p><button>Message</button>'
  const frameDoc = (iframe) => {
    layout(iframe.contentWindow)
    return iframe.contentDocument
  }
  const inner = frameDoc(doc.getElementById('same'))
  inner.title = 'Inner title'
  inner.body.innerHTML = '<p>Level one <a href="/in">inner link</a></p><iframe id="deeper"></iframe>'
  const deeper = frameDoc(inner.getElementById('deeper'))
  deeper.body.innerHTML = '<p>Level two</p><iframe></iframe>'
  frameDoc(deeper.querySelector('iframe')).body.innerHTML = '<p>Level three</p><iframe></iframe>'
  Object.defineProperty(doc.getElementById('cross'), 'contentDocument', { get: () => null })
  return window
}

// As plain data from this realm, as executeJavaScript hands it over, without the timing.
const read = (window, script = READ_PAGE_SCRIPT) => {
  const page = JSON.parse(JSON.stringify(window.eval(script)))
  delete page.stats.ms
  return page
}

test('the reader turns the visible page into Markdown with marked links and controls', () => {
  const page = read(makePage())
  assert.equal(page.format, 'markdown')
  assert.equal(page.title, 'Sample')
  assert.equal(page.lang, 'en')
  assert.equal(page.description, 'About the sample')
  assert.equal(page.truncated, undefined)
  const { text } = page
  const has = fragment => assert.ok(text.includes(fragment), `missing:\n${fragment}\n--- in ---\n${text}`)
  has('# Sample page[#1]\n\nSome `code` and a doc link[#2].\nNext line.')
  has('- Fruit\n  3. Apple\n  4. Pear ripe green\n- Vegetables')
  has('Table: Plan\n\n| Day | Who | Task |\n| --- | --- | --- |\n| Mon | Writer | Draft \\| review |\n| Mon | Coder | Fix |\n| All |  | Retro |')
  has('```js\nlet a = 1\n  indented()\n```')
  has('> Quoted one.\n>\n> Quoted two.\n\n---')
  has('shown child')
  has('More[#3]')
  has('[image: A dot] after.')
  has('### Aria heading')
  has('### Bot: Chief\n\nFallback\n\nMessage[#4]')
  has('[iframe: Inner (about:blank)]\nLevel one inner link[#13]')
  has('Level three\n\n[iframe (nested too deep, not read): about:blank]')
  has('[iframe (cross-origin, not readable): https://other.example/embed]')
  for (const hidden of ['HIDDEN', 'LIGHT-UNSLOTTED', 'nobody', 'SECRET', 'SCRIPT-TEXT', '.x{}']) {
    assert.ok(!JSON.stringify(page).includes(hidden), `${hidden} leaked`)
  }
  // A text box's value is listed with the control, not repeated in the text.
  assert.ok(!text.includes('DRAFT'))
  assert.equal(page.items[11].value, 'DRAFT-IN-TEXTAREA')
  assert.deepEqual(page.items.map(item => [item.role, item.name]), [
    ['link', 'page'], ['link', 'doc link'], ['button', 'More'], ['button', 'Message'],
    ['textbox', 'User'], ['textbox', 'Password'], ['textbox', 'Card'], ['textbox', 'Code'],
    ['checkbox', 'Remember'], ['select', 'Color'], ['button', 'Send'], ['textbox', ''], ['link', 'inner link'],
  ])
  const byName = Object.fromEntries(page.items.map(item => [item.name, item]))
  assert.equal(byName['doc link'].href, 'https://example.com/docs')
  assert.equal(byName.User.value, 'writer@example.com')
  for (const secret of ['Password', 'Card', 'Code']) assert.equal(byName[secret].value, undefined)
  assert.equal(byName.Remember.checked, true)
  assert.equal(byName.Color.value, 'Blue')
  assert.equal(byName.Send.disabled, true)
  assert.equal(page.stats.frames, 3)
})

test('the numbers in the text and the list agree, frames and shadow roots included', () => {
  const page = read(makePage())
  const marks = [...page.text.matchAll(/\[#(\d+)\]/g)].map(match => Number(match[1]))
  assert.deepEqual(marks, page.items.map((_, index) => index + 1))
  assert.equal(page.items[marks[marks.length - 1] - 1].name, 'inner link')
})

test('the limits stop the walk and say why', () => {
  const window = makePage()
  const page = read(window, readPageScript({ ...READ_LIMITS, nodes: 40, items: 2 }))
  assert.match(page.truncated, /more than 40 nodes/)
  assert.equal(page.items.length, 2)
  assert.ok(page.text.startsWith('# Sample page[#1]'))
})

test('a big table is cut at the row limit with a note', () => {
  const window = makePage()
  const doc = window.document
  // Narrow layouts often restyle a table as a block; it still reads as a table.
  doc.body.innerHTML = `<table style="display:block"><tr><th>n</th><th>v</th></tr>${Array.from({ length: 30 }, (_, i) => `<tr><td>${i}</td><td>v${i}</td></tr>`).join('')}</table>`
  const { text } = read(window, readPageScript({ ...READ_LIMITS, tableRows: 11 }))
  assert.match(text, /\| 10 \| v10 \|\n… \(table cut: 19 more rows\)$/)
})

test('the bundled reader reads the same as the source', async () => {
  const result = await build({ absWorkingDir: PLUGIN, entryPoints: ['src/client/read-page.js'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent' })
  const bundled = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
  assert.deepEqual(read(makePage(), bundled.READ_PAGE_SCRIPT), read(makePage()))
})
