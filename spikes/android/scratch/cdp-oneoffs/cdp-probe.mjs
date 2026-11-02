
const http = await import('node:http');
function post(port, path, body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const req = http.default.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, r => {
      let buf = '';
      r.on('data', c => buf += c);
      r.on('end', () => { try { res(JSON.parse(buf)); } catch (e) { res({ raw: buf }); } });
    });
    req.on('error', rej);
    req.write(data); req.end();
  });
}
const expr = `(async () => {
  const out = {};
  out.supportsNesting = CSS.supports('selector(&)');
  out.supportsContainer = CSS.supports('container-type', 'size');
  out.supportsHas = CSS.supports('selector(:has(a))');
  out.dvh = CSS.supports('height', '100dvh');
  const views = document.querySelectorAll('foliate-view');
  out.foliateViewCount = views.length;
  if (views.length) {
    const v = views[0];
    out.hasShadow = !!v.shadowRoot;
    if (v.shadowRoot) {
      const sheets = v.shadowRoot.styleSheets;
      out.shadowSheetCount = sheets.length;
      try { out.firstRules = Array.from(sheets[0].cssRules || []).map(r => r.cssText.slice(0, 70)); } catch (e) { out.firstRules = ['ERR:' + e.message]; }
      const top = v.shadowRoot.getElementById('top');
      if (top) { const cs = getComputedStyle(top); out.topDisplay = cs.display; out.topW = cs.width; out.topH = cs.height; out.maxColSpread = cs.getPropertyValue('--_max-column-count-spread'); }
      const cont = v.shadowRoot.getElementById('container');
      if (cont) { const c = getComputedStyle(cont); out.contW = c.width; out.contH = c.height; }
      out.shadowIframes = v.shadowRoot.querySelectorAll('iframe').length;
    }
  }
  out.docIframes = document.querySelectorAll('iframe').length;
  out.bodyText = document.body.innerText.slice(0, 80);
  return out;
})()`;
const list = await post(9333, '/json/list', {});
const targets = Array.isArray(list) ? list : [];
console.log('TARGETS:', targets.map(t => t.type + ' ' + t.url).join(' | '));
const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) { console.log('no page target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const result = await new Promise(res => {
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id === 1) res(d); };
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
});
console.log(JSON.stringify(result.result, null, 1));
ws.close();
