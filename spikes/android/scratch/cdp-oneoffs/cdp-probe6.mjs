
const http = await import('node:http');
function get(port, path) {
  return new Promise((res, rej) => {
    http.default.get({ host: '127.0.0.1', port, path }, r => {
      let buf = ''; r.on('data', c => buf += c);
      r.on('end', () => { try { res(JSON.parse(buf)); } catch (e) { res({ raw: buf }); } });
    }).on('error', rej);
  });
}
const list = await get(9333, '/json/list');
const targets = Array.isArray(list) ? list : [];
console.log('TARGETS:', targets.map(t => t.type + ' ' + t.url).join(' | '));
const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) { console.log('NO PAGE TARGET; raw=' + JSON.stringify(list).slice(0,300)); process.exit(0); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const call = (method, params) => new Promise(res => {
  const myId = ++id;
  const h = m => { const d = JSON.parse(m.data); if (d.id === myId) { ws.removeEventListener('message', h); res(d); } };
  ws.addEventListener('message', h);
  ws.send(JSON.stringify({ id: myId, method, params }));
});
await call('Runtime.enable', {});
await call('Log.enable', {});
await call('Page.enable', {});
// 收集 console/异常
const events = [];
ws.addEventListener('message', m => {
  const d = JSON.parse(m.data);
  if (d.method === 'Runtime.exceptionThrown') events.push('EXC: ' + JSON.stringify(d.params.exceptionDetails).slice(0, 400));
  if (d.method === 'Runtime.consoleAPICalled') events.push('LOG[' + d.params.type + ']: ' + d.params.args.map(a => String(a.value ?? a.description ?? '')).join(' ').slice(0, 300));
});
// 导航到 reader/sample 并等待
await call('Runtime.evaluate', { expression: "location.hash = '#/reader/sample'", awaitPromise: true });
await new Promise(r => setTimeout(r, 15000));
const res = await call('Runtime.evaluate', { expression: `JSON.stringify({
  iframes: document.querySelectorAll('iframe').length,
  bodyText: document.body.innerText.slice(0,80),
  view: (()=>{ const v=document.querySelector('foliate-view'); return v? {hasRenderer: !!v.renderer, hasBook: !!v.book, lastLoc: v.lastLocation ? String(v.lastLocation) : null} : 'none' })(),
})`, awaitPromise: true, returnByValue: true });
console.log('STATE:', res.result?.result?.value);
console.log('EVENTS:');
for (const e of events.slice(0, 25)) console.log('  ' + e);
ws.close();
