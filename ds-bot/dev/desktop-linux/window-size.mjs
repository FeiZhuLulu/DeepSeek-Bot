// Resize the Desktop window through the main process inspector (launch.mts opens it on
// 9429); Electron's renderer port has no Browser.setWindowBounds.
// Usage: node window-size.mjs <width> <height> [main-inspect-port=9429]
const [width = '1400', height = '860', port = '9429'] = process.argv.slice(2)
const [target] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
const expression = `(async () => {
  const { BrowserWindow } = process.getBuiltinModule('module').createRequire(process.execPath)('electron')
  const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed() && candidate.isVisible())
  window.setBounds({ x: 0, y: 0, width: ${Number(width)}, height: ${Number(height)} })
  return JSON.stringify(window.getBounds())
})()`
socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, includeCommandLineAPI: true } }))
const reply = await new Promise(resolve => { socket.onmessage = event => resolve(JSON.parse(event.data)) })
socket.close()
const value = reply.result?.result?.value
if (!value) {
  console.error(JSON.stringify(reply.result?.exceptionDetails ?? reply).slice(0, 600))
  process.exit(1)
}
console.log(`window bounds ${value}`)
