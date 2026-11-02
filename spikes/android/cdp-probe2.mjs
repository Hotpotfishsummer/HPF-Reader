
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
const expr = `(async () => {
  const out = {};
  const v = document.querySelector('foliate-view');
  if (!v) return { err: 'no view' };
  out.tagName = v.tagName;
  out.isCustomElementDefined = !!(customElements.get('foliate-view'));
  out.hasShadowRootProp = !!v.shadowRoot;
  out.attachShadowFn = typeof v.attachShadow;
  // 该元素原型链上是否有 constructor 执行过（自定义元素是否 upgraded）
  out.ctorName = v.constructor && v.constructor.name;
  out.childrenCount = v.children.length;
  out.innerHTMLLen = v.innerHTML.length;
  out.innerHTMLHead = v.innerHTML.slice(0, 200);
  // 尝试在空白 div 上 attachShadow 验证 API 可用性
  try { const d = document.createElement('div'); const sr = d.attachShadow({mode:'open'}); sr.innerHTML='<span>x</span>'; out.attachShadowWorks = true; } catch(e) { out.attachShadowWorks = 'ERR:' + e.message; }
  // open 方法状态
  out.hasOpen = typeof v.open;
  out.hasInit = typeof v.init;
  out.protoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(v)).slice(0, 20);
  // book / sections
  try { out.viewKeys = Object.keys(v); } catch(e) { out.viewKeys = 'ERR'; }
  // 事件历史：挂一个错误监听，再触发 open
  return out;
})()`;
const list = await post(9333, '/json/list', {});
const page = (Array.isArray(list) ? list : []).find(t => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) { console.log('no page'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const result = await new Promise(res => {
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id === 1) res(d); };
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
});
console.log(JSON.stringify(result.result, null, 1));
ws.close();
