
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
// 判定性实验：把阅读页 iframe 里的真实错误抓出来
const expr = `(async () => {
  const out = { steps: [] };
  // 1) 检查 renderer 是否被创建（renderer 由 View 的 open 设置）
  const v = document.querySelector('foliate-view');
  out.rendererType = v && v.renderer ? typeof v.renderer : 'none';
  out.bookType = v && v.book ? 'present' : 'none';
  // 2) 重新定义一个探针自定义元素，测试 class field + attachShadow 在 91 上是否可用
  try {
    class Probe extends HTMLElement {
      #root = this.attachShadow({ mode: 'open' })
      constructor() { super(); this.#root.innerHTML = '<span>ok</span>'; }
      get sr() { return this.#root }
    }
    customElements.define('probe-el', Probe);
    const p = document.createElement('probe-el');
    document.body.appendChild(p);
    out.classFieldAttachShadow = !!p.sr;
    out.probeInner = p.sr ? p.sr.innerHTML : 'none';
  } catch (e) { out.classFieldAttachShadow = 'ERR:' + e.message; }
  // 3) 用 try/catch 手动复现 View 的字段初始化顺序
  try {
    const Cls = customElements.get('foliate-view');
    out.viewClassFound = !!Cls;
    if (Cls) {
      // 直接调用构造函数（不能 new 自定义元素，但能看 prototype）
      out.hasRootField = Object.getOwnPropertyNames(Cls.prototype).length;
    }
  } catch (e) { out.step3 = 'ERR:' + e.message; }
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
