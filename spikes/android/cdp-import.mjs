
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
  if (d.method === 'Runtime.exceptionThrown') evs.push('EXC ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text || '').slice(0, 500));
  if (d.method === 'Runtime.consoleAPICalled') evs.push('LOG ' + d.params.args.map(a => String(a.value ?? a.description ?? '')).join(' ').slice(0, 400));
});
// 通过 Go 绑定导入真书
const importExpr = `(async () => {
  const out = {};
  try {
    const r = await window.wails.invoke('github.com/hotpotfish/hpfreader/client.LibraryService.ImportBook', '/sdcard/Download/frankenstein.epub');
    out.imported = JSON.stringify(r).slice(0, 300);
  } catch (e) { out.importError = String(e.message || e).slice(0, 400); }
  try { const l = await window.wails.invoke('github.com/hotpotfish/hpfreader/client.LibraryService.ListBooks'); out.books = JSON.stringify(l).slice(0, 400); } catch (e) { out.listError = String(e.message||e).slice(0,300); }
  return out;
})()`;
const r1 = await call('Runtime.evaluate', { expression: importExpr, awaitPromise: true, returnByValue: true });
console.log('IMPORT:', JSON.stringify(r1.result?.result?.value ?? r1.result).slice(0, 900));
ws.close();
