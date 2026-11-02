(async function(){
  var f = document.querySelector('foliate-view');
  if (!f) return JSON.stringify({hasView:false});
  var out = { hasView:true, hasBook: !!f.book, methods: [] };
  for (var k in f) { if (typeof f[k] === 'function' && /next|prev|goTo|init|open/i.test(k)) out.methods.push(k) }
  try {
    out.lastLoc = f.lastLocation ? { fraction: f.lastLocation.fraction, cfi: f.lastLocation.cfi } : null;
    out.tocCount = f.book && f.book.toc ? f.book.toc.length : null;
  } catch(e) { out.err = String(e) }
  return JSON.stringify(out);
})()