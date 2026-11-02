
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
  if (d.method === 'Runtime.exceptionThrown') evs.push('EXC ' + (d.params.exceptionDetails.exception?.description || '').slice(0, 500));
});
// 决定性：直接跳到 Chapter 10 并读取实际渲染文本
const expr = `(async () => {
  const out = {};
  const v = document.querySelector('foliate-view');
  // 正确 API：v.book.toc（不是 getTOC）
  try {
    const toc = v.book.toc || [];
    out.tocCount = toc.length;
    out.tocLabels = toc.slice(0, 5).map(x => x.label);
    const target = toc.find(x => String(x.label||'').trim() === 'Chapter 10') || toc[12];
    out.target = target ? String(target.label) : 'none';
    if (target) {
      await v.goTo(target.href || target);
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch (e) { out.jumpErr = String(e.message || e).slice(0, 300); }
  // 读渲染结果：从 closed shadow 拿不到，但可用 lastLocation + 截图判断
  out.afterFrac = v.lastLocation ? +v.lastLocation.fraction.toFixed(4) : null;
  out.afterCfi = v.lastLocation ? String(v.lastLocation.cfi||'').slice(0, 45) : null;
  // 关键：paginator 内部的 iframe 是否存在（用 view 的 #root 不可见，改判 renderer）
  out.rendererType = v.renderer ? v.renderer.constructor.name : 'none';
  return out;
})()`;
const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log('JUMP_RESULT:', JSON.stringify(r.result?.result?.value ?? r.result, null, 1).slice(0, 1200));
console.log('EXC:', evs.slice(0,5).join(' | ') || 'none');
ws.close();
