(function(){
  // DIAGNOSTIC ONLY: re-emit the app stylesheet with @layer blocks flattened,
  // to prove that CSS cascade layers are the sole blocker on WebView 91.
  var sheets = Array.prototype.slice.call(document.styleSheets);
  var target = null;
  for (var i = 0; i < sheets.length; i++) {
    var href = sheets[i].href || '';
    if (href.indexOf('/assets/') >= 0 && href.slice(-4) === '.css') { target = sheets[i]; break }
  }
  if (!target) return JSON.stringify({ok:false, err:'no app css sheet found', hrefs: sheets.map(function(s){return s.href})});
  var rules = null;
  try { rules = target.cssRules } catch (e) { return JSON.stringify({ok:false, err:'cssRules blocked: '+e.message}) }
  var out = [];
  var skipped = 0;
  for (var r = 0; r < rules.length; r++) {
    var rule = rules[r];
    if (rule.constructor && rule.constructor.name === 'CSSLayerBlockRule') {
      // hoist children out of the layer
      var kids = rule.cssRules || [];
      for (var k = 0; k < kids.length; k++) {
        var kid = kids[k];
        if (kid.constructor && kid.constructor.name === 'CSSLayerBlockRule') {
          var gk = kid.cssRules || [];
          for (var g = 0; g < gk.length; g++) out.push(gk[g].cssText);
        } else out.push(kid.cssText);
      }
      skipped++;
    } else if (rule.constructor && rule.constructor.name === 'CSSLayerStatementRule') {
      skipped++;
    } else {
      out.push(rule.cssText);
    }
  }
  var flat = document.createElement('style');
  flat.id = '__flat';
  flat.textContent = out.join('\n');
  document.head.appendChild(flat);
  var d = document.createElement('div');
  d.className = 'absolute inset-0';
  document.body.appendChild(d);
  var pos = getComputedStyle(d).position;
  d.remove();
  return JSON.stringify({ok:true, hoistedLayerBlocks:skipped, emittedRules:out.length, absolutePos:pos, cssBytes:flat.textContent.length});
})()