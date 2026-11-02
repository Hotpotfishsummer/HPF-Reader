(async function(){
  var out = {};
  var cands = ['dist-DXUMBP2b.js','platform-B5PSDNiE.js','useApi-CUWMwLLw-Bz-hoMMH.js','LibraryView-oXc_08iT.js'];
  for (var i=0;i<cands.length;i++){
    try {
      var m = await import('/assets/'+cands[i]);
      out[cands[i]] = Object.keys(m).slice(0,40);
    } catch(e) { out[cands[i]] = 'ERR: '+String(e).slice(0,100) }
  }
  return JSON.stringify(out);
})()