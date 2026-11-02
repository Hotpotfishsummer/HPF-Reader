(async function(){
  var results = {};
  var ids = ['08a2de3a58226311','bf04d57cf243314a','2172db6a64d45b02'];
  for (var i=0;i<ids.length;i++){
    var id = ids[i];
    location.hash = '#/reader/' + id;
    await new Promise(function(r){ setTimeout(r, 14000) });
    var f = document.querySelector('foliate-view');
    if (!f) { results[id] = {err:'no foliate-view'}; continue }
    results[id] = {
      hasBook: !!f.book,
      tocCount: f.book && f.book.toc ? f.book.toc.length : null,
      fraction: f.lastLocation ? Math.round(f.lastLocation.fraction*10000)/10000 : null,
      fvH: f.offsetHeight,
      innerH: innerHeight,
      text: document.body.innerText.slice(0,60).replace(/\n/g,' | ')
    };
  }
  return JSON.stringify(results);
})()