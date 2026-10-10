// Sample pages for the Bot browser reader (test/fixtures/read-page), plus a generated
// large table at /big-table.html?rows=N. Open http://127.0.0.1:<port>/ : its second iframe
// loads from http://localhost:<port>/, another origin, so it shows the cross-origin case.
//   node dev/read-pages.mjs [port=8833]
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, normalize } from 'node:path'

const port = Number(process.argv[2] ?? 8833)
const root = join(import.meta.dirname, '..', 'test', 'fixtures', 'read-page')

const bigTable = (rows) => {
  const body = Array.from({ length: rows }, (_, index) => `<tr><td>${index + 1}</td><td>Item ${index + 1}</td><td>${(index * 37) % 1000}</td><td><a href="/item/${index + 1}">open</a></td></tr>`).join('')
  return `<!doctype html><meta charset="utf-8"><title>Big table (${rows} rows)</title><h1>Big table</h1><table><thead><tr><th>#</th><th>Name</th><th>Score</th><th>Link</th></tr></thead><tbody>${body}</tbody></table>`
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://local')
  if (url.pathname === '/big-table.html') {
    const rows = Math.min(50_000, Math.max(1, Number(url.searchParams.get('rows')) || 3000))
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(bigTable(rows))
    return
  }
  const name = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '')
  try {
    const file = await readFile(join(root, name))
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(file)
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  }
})
server.listen(port, '127.0.0.1', () => console.log(`reader sample pages on http://127.0.0.1:${port}/ (cross-origin frame from localhost:${port})`))
