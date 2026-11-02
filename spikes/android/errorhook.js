(function(){
  window.__ERRS = [];
  var push = function(kind, msg, extra){ try { window.__ERRS.push({kind:kind, msg:String(msg).slice(0,400), extra:extra||null}) } catch(e){} };
  window.addEventListener('error', function(e){ push('error', e.message, (e.filename||'')+':'+e.lineno) }, true);
  window.addEventListener('unhandledrejection', function(e){ var r=e.reason; push('rejection', (r && (r.stack||r.message)) || r, null) }, true);
  var ce = console.error; console.error = function(){ push('console.error', Array.prototype.join.call(arguments,' '), null); return ce.apply(console, arguments) };
  var cw = console.warn; console.warn = function(){ push('console.warn', Array.prototype.join.call(arguments,' '), null); return cw.apply(console, arguments) };
  try { localStorage.clear() } catch(e) {}
})()