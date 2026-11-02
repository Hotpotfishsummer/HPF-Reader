
const http = await import('node:http');
function post(port, path, body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const req = http.default.request({ host: '127.0.0.1', port, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, r => {
      let buf = ''; r.on('data', c => buf += c);
      r.on('end', () => { try { res(JSON.parse(buf)); } catch (e) { res({ raw: buf }); } });
    });
    req.on('error', rej); req.write(data); req.end();
  });
}
// 打开真书：走 Go 绑定的路径（app service 里有 OpenLocalFile/ReadLocalFile）
const expr = `(async () => {
  const out = { tries: [] };
  const w = window.wails;
  // 列出 invoke 可用的服务方法（Wails v3 把绑定挂在 window.go 或 wails.invoke 动态）
  out.platform = w.platform;
  // 试 app service 方法名
  const candidates = ['AppService', 'LibraryService', 'OpenLocalFile', 'ReadLocalFile', 'ListLibrary'];
  for (const c of candidates) {
    try {
      const r = await Promise.race([
        w.invoke(c, {}),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
      ]);
      out.tries.push({ name: c, ok: true, res: JSON.stringify(r).slice(0, 200) });
    } catch (e) {
      out.tries.push({ name: c, ok: false, err: String(e.message || e).slice(0, 160) });
    }
  }
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
console.log(JSON.stringify(result.result, null, 1).slice(0, 2000));
ws.close();
