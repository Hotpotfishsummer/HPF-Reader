
const http = await import('node:http');
function post(port, path, body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const req = http.default.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, r => {
      let buf = ''; r.on('data', c => buf += c);
      r.on('end', () => { try { res(JSON.parse(buf)); } catch (e) { res({ raw: buf }); } });
    });
    req.on('error', rej); req.write(data); req.end();
  });
}
// 用真实书：通过页面的 Wails 绑定打开 testdata 里的 frankenstein（走 readLocalFile）
const expr = `(async () => {
  const out = { ua: navigator.userAgent };
  const v = document.querySelector('foliate-view');
  out.beforeHasShadow = !!v.shadowRoot;
  out.beforeRenderer = v && v.renderer ? 'present' : 'none';
  out.beforeBook = v && v.book ? 'present' : 'none';
  // 直接读真书：用 fetch 从 wails.localhost 拿不到本地文件，改走 Go 绑定
  try {
    const app = window.go && window.go.github && window.go.github.hotpotfish;
    out.goShape = app ? Object.keys(app) : 'no go binding';
  } catch (e) { out.goShape = 'ERR:' + e.message; }
  out.wailsKeys = Object.keys(window.wails || {});
  return out;
})()`;
const list = await post(9333, '/json/list', {});
const page = (Array.isArray(list) ? list : []).find(t => t.type === 'page' && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const result = await new Promise(res => {
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id === 1) res(d); };
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
});
console.log(JSON.stringify(result.result, null, 1));
ws.close();
