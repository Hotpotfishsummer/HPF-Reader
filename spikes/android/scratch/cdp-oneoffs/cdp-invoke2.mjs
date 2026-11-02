
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
  if (d.method === 'Runtime.exceptionThrown') evs.push('EXC ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text || '').slice(0, 600));
  if (d.method === 'Runtime.consoleAPICalled') evs.push('LOG ' + d.params.args.map(a => String(a.value ?? a.description ?? '')).join(' ').slice(0, 500));
});
// 用生成的 bindings 模块（Vite 打包后没有模块名，但 Wails 的 invoke 支持 "Service.Method" 简名）
const expr = `(async () => {
  const out = {};
  const attempts = [
    'LibraryService.ImportBook',
    'libraryservice.ImportBook',
    'ImportBook',
  ];
  for (const m of attempts) {
    try {
      const r = await Promise.race([
        window.wails.invoke(m, '/sdcard/Download/frankenstein.epub'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
      ]);
      out[m] = 'OK ' + JSON.stringify(r).slice(0, 250);
    } catch (e) { out[m] = 'ERR ' + String(e.message || e).slice(0, 200); }
  }
  return out;
})()`;
const r1 = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log('INVOKE:', JSON.stringify(r1.result?.result?.value ?? r1.result).slice(0, 1200));
console.log('EVENTS:');
for (const e of evs.slice(0, 20)) console.log('  ' + e);
ws.close();
