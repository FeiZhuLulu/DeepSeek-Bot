// A local page for the Bot browser check: it shows the cookies its partition holds and
// sets `bot=<name>` when opened with #<name>. Opened in two Bots' browsers, each sees
// only its own cookie.
//   node cookie-page.mjs [port=8791]
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 8791)
const page = `<!doctype html><meta charset="utf-8"><title>Cookie check</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:40px;color:#222}code{background:#f2f2f2;padding:2px 6px;border-radius:4px}</style>
<h1>Cookie check</h1>
<p>This page sets a cookie named after the Bot whose browser opened it, then lists every cookie this browser holds.</p>
<p id="out"></p>
<script>
const name = decodeURIComponent(location.hash.slice(1))
if (name) document.cookie = 'bot=' + encodeURIComponent(name) + '; max-age=86400; path=/'
document.getElementById('out').innerHTML = document.cookie
  ? 'Cookies here: <code>' + document.cookie.replace(/[<&]/g, c => c === '<' ? '&lt;' : '&amp;') + '</code>'
  : 'No cookies here.'
</script>`
createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(page)
}).listen(port, '127.0.0.1', () => console.log(`cookie page on http://127.0.0.1:${port}/`))
