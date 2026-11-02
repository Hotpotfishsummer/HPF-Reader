
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
const expr = `(async () => {
  const out = {};
  const C = globalThis.DecompressionStream;
  out.ctorSrc = String(C).slice(0, 300);
  out.ctorName = C && C.name;
  out.isShim = !!(C && C.prototype && C.prototype.constructor === C);
  out.caps = window.__HPF_CAPABILITIES__ ? JSON.stringify(window.__HPF_CAPABILITIES__).slice(0, 600) : 'absent';
  // 直接看 polyfill 是否可用：是否有我们注入的痕迹
  out.hasGroupBy = typeof Object.groupBy;
  out.hasFindLastIndex = typeof [].findLastIndex;
  out.hasAt = typeof [].at;
  return out;
})()`;
const r1 = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log('SHIM_STATE:', JSON.stringify(r1.result?.result?.value ?? r1.result, null, 1).slice(0, 1600));
ws.close();
