
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
  if (d.method === 'Runtime.exceptionThrown') evs.push('EXC ' + (d.params.exceptionDetails.exception?.description || '').slice(0, 600));
});
const st = async (label) => {
  const r = await call('Runtime.evaluate', { expression: `JSON.stringify({
    bodyText: document.body.innerText.slice(0, 120),
    loc: (()=>{ const v=document.querySelector('foliate-view'); return v && v.lastLocation ? { fraction: +v.lastLocation.fraction.toFixed(4), cfi: String(v.lastLocation.cfi||'').slice(0,45) } : null })(),
  })`, awaitPromise: true, returnByValue: true });
  console.log(label + ': ' + (r.result?.result?.value ?? ''));
};
await st('INITIAL');
// 翻页：调用 foliate 的 next
await call('Runtime.evaluate', { expression: "document.querySelector('foliate-view').next()", awaitPromise: true });
await new Promise(r => setTimeout(r, 2500));
await st('AFTER_NEXT_1');
await call('Runtime.evaluate', { expression: "document.querySelector('foliate-view').next()", awaitPromise: true });
await new Promise(r => setTimeout(r, 2500));
await st('AFTER_NEXT_2');
// 跳章：打开目录并跳转
const toc = await call('Runtime.evaluate', { expression: `(async () => {
  const v = document.querySelector('foliate-view');
  try {
    const t = await v.book.getTOC();
    return JSON.stringify({ tocCount: (t||[]).length, first: (t||[]).slice(0,3).map(x=>x.label) });
  } catch(e) { return 'ERR:' + e.message }
})()`, awaitPromise: true, returnByValue: true });
console.log('TOC: ' + (toc.result?.result?.value ?? ''));
// 跳到一个后面的章节
const jump = await call('Runtime.evaluate', { expression: `(async () => {
  const v = document.querySelector('foliate-view');
  try {
    const t = await v.book.getTOC();
    const target = t.find(x => String(x.label||'').includes('Chapter 10')) || t[10] || t[t.length-1];
    await v.goTo(target.href || target);
    return JSON.stringify({ jumpedTo: String(target.label||'') });
  } catch(e) { return 'ERR:' + e.message }
})()`, awaitPromise: true, returnByValue: true });
console.log('JUMP: ' + (jump.result?.result?.value ?? ''));
await new Promise(r => setTimeout(r, 4000));
await st('AFTER_JUMP');
console.log('EXC: ' + (evs.slice(0,6).join(' | ') || 'none'));
ws.close();
