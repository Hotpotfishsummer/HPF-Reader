
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
  if (d.method === 'Runtime.consoleAPICalled') evs.push('LOG ' + d.params.args.map(a => String(a.value ?? a.description ?? '')).join(' ').slice(0, 500));
});
// 直接用 foliate 的 View.open 打开设备上的真书（通过 fetch 到 wails.localhost 读不到，但可以把书 base64 塞进去）
const expr = `(async () => {
  const out = { steps: [] };
  try {
    // 拿到当前的 foliate-view 实例，并检查它能否读 File
    const v = document.querySelector('foliate-view');
    out.hasView = !!v;
    // 检查 zip.js 的关键能力：DecompressionStream 的三种格式
    const probe = (f) => { try { new DecompressionStream(f); return 'ok' } catch (e) { return 'THROW:' + e.message } };
    out.dsRaw = probe('deflate-raw');
    out.dsDeflate = probe('deflate');
    out.dsGzip = probe('gzip');
    // 关键：Blob/FileReader/arrayBuffer
    out.blobSlice = typeof new Blob([new Uint8Array([1,2,3])]).slice(0,1).arrayBuffer;
    return out;
  } catch (e) { out.err = String(e.message || e); return out; }
})()`;
const r1 = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log('CAPS:', JSON.stringify(r1.result?.result?.value ?? r1.result).slice(0, 1200));
console.log('EVENTS:', evs.slice(0, 10).join(' | ').slice(0, 800));
ws.close();
