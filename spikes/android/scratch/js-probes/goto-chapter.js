(async function(){
  var f = document.querySelector('foliate-view');
  if (!f) return JSON.stringify({err:'no view'});
  if (!f.book || !f.book.toc) return JSON.stringify({err:'no toc'});
  var toc = f.book.toc;
  // find a Chapter N item
  function find(nodes, target){
    for (var i=0;i<nodes.length;i++){
      var n = nodes[i];
      if (n.label && n.label.trim() === target) return n;
      if (n.children) { var r = find(n.children, target); if (r) return r }
    }
    return null;
  }
  var item = find(toc, 'Chapter 10') || find(toc, 'Chapter 5');
  if (!item) return JSON.stringify({err:'chapter not found', labels: toc.slice(0,10).map(function(x){return x.label})});
  await f.goTo(item.href || item.href);
  await new Promise(function(r){ setTimeout(r, 2000) });
  return JSON.stringify({
    jumpedTo: item.label,
    href: item.href,
    fraction: Math.round(f.lastLocation.fraction*10000)/10000,
    cfi: f.lastLocation.cfi,
    innerH: innerHeight,
    fvH: f.offsetHeight,
    text: document.body.innerText.slice(0,90).replace(/\n/g,' | ')
  });
})()