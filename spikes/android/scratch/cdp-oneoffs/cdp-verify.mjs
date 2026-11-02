
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
  if (d.method === 'Runtime.consoleAPICalled') evs.push('LOG ' + d.params.args.map(a => String(a.value ?? a.description ?? '')).join(' ').slice(0, 400));
});
// 1) 能力探测
const caps = await call('Runtime.evaluate', { expression: `JSON.stringify({
  dsRaw: (()=>{ try { new DecompressionStream('deflate-raw'); return 'ok' } catch(e) { return 'THROW:'+e.message } })(),
  dsDeflate: (()=>{ try { new DecompressionStream('deflate'); return 'ok' } catch(e) { return 'THROW' } })(),
  caps: window.__HPF_CAPABILITIES__ ? JSON.stringify(window.__HPF_CAPABILITIES__) : 'absent',
})`, awaitPromise: true, returnByValue: true });
console.log('CAPS:', caps.result?.result?.value);
// 2) 让页面真的打开真书：模拟用户点「打开本地文件」不行（原生对话框），改用把书字节灌进 localStorage 的桥
//    先看前端如何拿到书字节：platform.readBookBytes -> LibraryService.ReadBookBytes
//    用 Wails 的 invoke 简名再试（v3 用 "服务名.方法" 或 "服务名:方法"）
const tryOpen = `(async () => {
  const out = {};
  const w = window.wails;
  out.invokeArity = w.invoke.length;
  const names = ['LibraryService.ReadBookBytes','AppService.DataDir'];
  for (const n of names) {
    for (const sep of ['.', ':', '/']) {
      const m = n.split('.')[0] + sep + n.split('.')[1];
      try {
        const r = await Promise.race([w.invoke(m, 'x'), new Promise((_,j)=>setTimeout(()=>j(new Error('t')),2000))]);
        out[m] = 'OK ' + JSON.stringify(r).slice(0,120);
      } catch (e) { out[m] = 'E:' + String(e.message||e).slice(0,60); }
    }
  }
  return out;
})()`;
const r2 = await call('Runtime.evaluate', { expression: tryOpen, awaitPromise: true, returnByValue: true });
console.log('INVOKE_FORMS:', JSON.stringify(r2.result?.result?.value ?? {}).slice(0, 900));
console.log('EVENTS:', evs.slice(0,8).join(' | ').slice(0,700));
ws.close();
