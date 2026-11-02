
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
const expr = `(() => {
  const out = {};
  // 1) CSS 能力
  out.supportsLayer = (()=>{ try { return CSS.supports('at-rule(@layer)') } catch(e){ return 'throw' } })();
  out.layerProbe = (() => {
    // 真实探测：插一个 @layer 规则看是否被解析
    const s = document.createElement('style');
    s.textContent = '@layer t { .zz{color:rgb(1,2,3)} }';
    document.head.appendChild(s);
    let n = -1;
    try { n = s.sheet.cssRules.length } catch(e) { n = 'ERR' }
    s.remove();
    return n;
  })();
  // 2) 样式表实际规则数与 layer 块数
  const sheets = Array.from(document.styleSheets);
  out.sheetCount = sheets.length;
  let top = 0, layerBlocks = 0;
  for (const sh of sheets) {
    try {
      const rules = Array.from(sh.cssRules || []);
      top += rules.length;
      layerBlocks += rules.filter(r => String(r.constructor.name).includes('LayerBlock') || String(r.cssText).startsWith('@layer')).length;
    } catch(e) {}
  }
  out.topLevelRules = top;
  out.layerBlockRules = layerBlocks;
  // 3) Tailwind 类是否真的生效（抽查）
  const probe = (sel, prop) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el)[prop] : 'no-el';
  };
  const btn = document.querySelector('button');
  out.buttonBorderRadius = btn ? getComputedStyle(btn).borderRadius : 'no-btn';
  out.buttonBg = btn ? getComputedStyle(btn).backgroundColor : 'no-btn';
  out.bodyFont = getComputedStyle(document.body).fontFamily;
  out.bodyBg = getComputedStyle(document.body).backgroundColor;
  // 4) foliate-view 高度（mobile-dev 说 1482 vs 视口 843）
  const v = document.querySelector('foliate-view');
  if (v) { const cs = getComputedStyle(v); out.fvHeight = cs.height; out.fvWidth = cs.width; }
  out.innerH = innerHeight;
  // 5) 真书是否真的渲染出正文（关键判据）
  out.bodyTextLen = document.body.innerText.length;
  out.bodyTextHead = document.body.innerText.slice(0, 120);
  out.hasBook = !!(v && v.book);
  out.hasRenderer = !!(v && v.renderer);
  out.lastLoc = (v && v.lastLocation) ? { fraction: +v.lastLocation.fraction.toFixed(4), cfi: String(v.lastLocation.cfi||'').slice(0,40) } : null;
  return out;
})()`;
const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 1).slice(0, 2000));
ws.close();
