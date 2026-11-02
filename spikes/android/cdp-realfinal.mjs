
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
const page = (Array.isArray(list) ? list : []).find(t => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) { console.log('no page'); process.exit(0); }
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
const evs = [];
ws.addEventListener('message', m => {
  const d = JSON.parse(m.data);
  if (d.method === 'Runtime.exceptionThrown') evs.push('EXC ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text || '').slice(0, 700));
  if (d.method === 'Runtime.consoleAPICalled') evs.push('LOG[' + d.params.type + '] ' + d.params.args.map(a => String(a.value ?? a.description ?? '')).join(' ').slice(0, 400));
});
// 导航到真书阅读页
await call('Runtime.evaluate', { expression: "location.hash = '#/reader/bf04d57cf243314a'", awaitPromise: true });
await new Promise(r => setTimeout(r, 20000));
const state = await call('Runtime.evaluate', { expression: `JSON.stringify({
  hash: location.hash,
  bodyText: document.body.innerText.slice(0, 200),
  view: (()=>{ const v=document.querySelector('foliate-view'); return v ? { hasBook: !!v.book, hasRenderer: !!v.renderer, lastLoc: v.lastLocation ? { fraction: v.lastLocation.fraction, cfi: String(v.lastLocation.cfi||'').slice(0,50) } : null } : 'none' })(),
})`, awaitPromise: true, returnByValue: true });
console.log('STATE:', state.result?.result?.value);
console.log('EVENTS:');
for (const e of evs.slice(0, 20)) console.log('  ' + e);
ws.close();
