/**
 * Minimal Chrome DevTools Protocol driver for the Wails Android WebView.
 *
 * Wails' Android MainActivity calls WebView.setWebContentsDebuggingEnabled(true)
 * in debug builds, so the WebView exposes a devtools socket. We forward it with
 *   adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 * and then drive it from here.
 *
 * This exists so acceptance can be MEASURED (DOM text, element rects, console
 * errors, page counts) instead of inferred from a screenshot.
 *
 * Usage: node cdp.mjs <devtoolsHttpBase> <command> [args...]
 *   list | eval <js> | text | probe | rect <sel> | click <sel> | hash <v> | shot <out.png>
 */
import { writeFileSync, readFileSync } from 'node:fs'

const base = process.argv[2]
const cmd = process.argv[3]
const cmdArgs = process.argv.slice(4)

if (!base || !cmd) {
  console.error('usage: node cdp.mjs <devtoolsHttpBase> <command> [args...]')
  process.exit(2)
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map() }
  static async connect(url) {
    const ws = new WebSocket(url)
    const c = new Cdp(ws)
    ws.addEventListener('message', function (ev) {
      const msg = JSON.parse(ev.data)
      if (msg.id !== undefined && c.pending.has(msg.id)) {
        const p = c.pending.get(msg.id)
        c.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
        else p.resolve(msg.result)
      }
    })
    await new Promise(function (resolve, reject) {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', function () { reject(new Error('ws error ' + url)) }, { once: true })
    })
    return c
  }
  send(method, params) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }))
    const self = this
    return new Promise(function (resolve, reject) { self.pending.set(id, { resolve: resolve, reject: reject }) })
  }
  close() { try { this.ws.close() } catch (e) {} }
}

const list = await (await fetch(base.replace(/\/$/, '') + '/json/list')).json()
if (cmd === 'list') {
  console.log(JSON.stringify(list.map(function (t) { return { title: t.title, url: t.url, type: t.type } }), null, 2))
  process.exit(0)
}

const page = list.find(function (t) { return t.type === 'page' }) || list[0]
if (!page) { console.error('no devtools target found'); process.exit(1) }

const c = await Cdp.connect(page.webSocketDebuggerUrl)
await c.send('Runtime.enable').catch(function () {})
await c.send('Log.enable').catch(function () {})

async function evalJs(expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return { exception: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text }
  return r.result ? r.result.value : undefined
}

const PROBE = [
  'JSON.stringify({',
  '  href: location.href,',
  '  title: document.title,',
  '  readyState: document.readyState,',
  '  bodyTextLen: (document.body ? document.body.innerText.length : -1),',
  '  bodyTextHead: (document.body ? document.body.innerText.slice(0, 500) : ""),',
  '  appChildren: document.getElementById("app") ? document.getElementById("app").children.length : -1,',
  '  iframeCount: document.querySelectorAll("iframe").length,',
  '  canvasCount: document.querySelectorAll("canvas").length,',
  '  rootBg: getComputedStyle(document.documentElement).backgroundColor,',
  '  rootH: document.documentElement.clientHeight,',
  '  rootW: document.documentElement.clientWidth,',
  '  hasWailsBridge: !!(window.wails && window.wails.invoke),',
  '  ua: navigator.userAgent',
  '})',
].join('\n')

let out
switch (cmd) {
  case 'eval': out = await evalJs(cmdArgs.join(' ')); break
  case 'text': out = await evalJs('document.body.innerText'); break
  case 'probe': out = JSON.parse(await evalJs(PROBE)); break
  case 'rect':
    out = await evalJs('(function(){var el=document.querySelector(' + JSON.stringify(cmdArgs[0]) + ');if(!el)return null;var r=el.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height,text:(el.innerText||"").slice(0,80)})})()')
    out = out ? JSON.parse(out) : null
    break
  case 'click':
    out = await evalJs('(function(){var el=document.querySelector(' + JSON.stringify(cmdArgs[0]) + ');if(!el)return "NOT_FOUND";el.click();return "CLICKED"})()')
    break
  case 'hash':
    out = await evalJs('location.hash = ' + JSON.stringify(cmdArgs[0]) + '; location.hash')
    break
  case 'findtext': {
    out = await evalJs('(function(){var t=' + JSON.stringify(cmdArgs[0]) + ';var els=document.querySelectorAll("button,a,[role=button],div,span,p");for(var i=0;i<els.length;i++){var e=els[i];if((e.innerText||"").trim()===t){var r=e.getBoundingClientRect();return JSON.stringify({tag:e.tagName,x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height})}}return null})()')
    out = out ? JSON.parse(out) : null
    break
  }
  case 'tap': {
    const x = Number(cmdArgs[0]); const y = Number(cmdArgs[1])
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x, y: y, button: 'left', clickCount: 1 })
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x, y: y, button: 'left', clickCount: 1 })
    out = { tapped: [x, y] }
    break
  }
  case 'watch': {
    // Collect console/exceptions for N ms after optionally reloading.
    const doReload = cmdArgs[0] === 'reload'
    const ms = Number(cmdArgs[1] || 20000)
    const events = []
    c.onEvent = function (method, params) {
      if (method === 'Log.entryAdded') {
        const e = params.entry
        events.push({ kind: 'log:' + e.level, text: (e.text || '').slice(0, 400), url: (e.url || '').slice(-60) })
      } else if (method === 'Runtime.consoleAPICalled') {
        const txt = (params.args || []).map(function (a) {
          return a.value !== undefined ? String(a.value) : (a.description || a.type)
        }).join(' ')
        events.push({ kind: 'console:' + params.type, text: txt.slice(0, 400) })
      } else if (method === 'Runtime.exceptionThrown') {
        const d = params.exceptionDetails || {}
        const ex = d.exception || {}
        events.push({ kind: 'exception', text: (ex.description || d.text || '').slice(0, 500), url: (d.url || '').slice(-60), line: d.lineNumber })
      }
    }
    if (doReload) { await c.send('Page.reload', { ignoreCache: true }) }
    await new Promise(function (r) { setTimeout(r, ms) })
    out = { eventCount: events.length, events: events.slice(-40) }
    break
  }
  case 'preloadrun': {
    // Single-session: inject -> reset route -> go to route -> settle -> probe.
    // Must be one session because the DevTools script registration dies with the socket.
    const src = readFileSync(cmdArgs[0], 'utf8')
    const hash = cmdArgs[1]
    const settle = Number(cmdArgs[2] || 9000)
    const reg = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: src })
    const before = await evalJs('typeof Object.groupBy')
    await evalJs(src)
    const afterInject = await evalJs('typeof Object.groupBy')
    await evalJs('location.hash = "#/"')
    await new Promise(function (r) { setTimeout(r, 800) })
    await evalJs('location.hash = ' + JSON.stringify(hash))
    await new Promise(function (r) { setTimeout(r, settle) })
    const probe = JSON.parse(await evalJs(PROBE))
    out = { scriptId: reg.identifier, beforeInject: before, afterInject: afterInject, settleMs: settle, probe: probe }
    break
  }
  case 'addscript': {
    const src = readFileSync(cmdArgs[0], 'utf8')
    const r = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: src })
    out = { registered: r.identifier, bytes: src.length }
    break
  }
  case 'reload': {
    await c.send('Page.reload', { ignoreCache: true })
    out = { reloaded: true }
    break
  }
  case 'goto':
    out = await evalJs('location.hash = ' + JSON.stringify(cmdArgs[0]) + '; location.href')
    break
  case 'shot': {
    const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const buf = Buffer.from(r.data, 'base64')
    writeFileSync(cmdArgs[0], buf)
    out = { saved: cmdArgs[0], bytes: buf.length }
    break
  }
  default:
    console.error('unknown command: ' + cmd)
    process.exit(2)
}

console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2))
c.close()
process.exit(0)
