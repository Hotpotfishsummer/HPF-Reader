(async function(){
  var id = location.hash.split('/').pop();
  var f = document.querySelector('foliate-view');
  if (!f) return JSON.stringify({route:id, err:'no foliate-view'});
  var toc = f.book && f.book.toc ? f.book.toc : [];
  // flatten labels
  function flat(nodes, out){ for (var i=0;i<nodes.length;i++){ out.push(nodes[i].label); if (nodes[i].children) flat(nodes[i].children, out) } return out }
  var labels = flat(toc, []);
  return JSON.stringify({
    route: id,
    hasBook: !!f.book,
    tocTopLevel: toc.length,
    tocAllLabels: labels.length,
    firstLabels: labels.slice(0,6),
    lastLabels: labels.slice(-3),
    fraction: f.lastLocation ? Math.round(f.lastLocation.fraction*10000)/10000 : null,
    fvH: f.offsetHeight,
    innerH: innerHeight
  });
})()