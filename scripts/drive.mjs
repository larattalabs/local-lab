#!/usr/bin/env node
/**
 * Drive the running app's renderer over CDP (see LOCALLAB_CDP in the README).
 *
 *   node scripts/drive.mjs <port> '<js expression>'
 *
 * The expression is evaluated in the page (await works); its resolved value
 * prints as JSON. Uses Node's built-in WebSocket — no dependencies.
 */
const [port, expr] = process.argv.slice(2)
if (!port || !expr) {
  console.error('usage: node scripts/drive.mjs <port> "<js expression>"')
  process.exit(2)
}
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) {
  console.error('no page target; found:', targets.map((t) => `${t.type}:${t.title}`))
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
const result = await new Promise((res, rej) => {
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) res(d) }
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
    expression: expr, awaitPromise: true, returnByValue: true } }))
  setTimeout(() => rej(new Error('CDP timeout')), 20000)
})
ws.close()
if (result.result.exceptionDetails) {
  console.error(JSON.stringify(result.result.exceptionDetails, null, 2))
  process.exit(1)
}
console.log(JSON.stringify(result.result.result.value ?? null))
