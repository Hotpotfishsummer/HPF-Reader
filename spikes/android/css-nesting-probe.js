(function(){
  function probe(css){
    var s=document.createElement('style'); s.textContent=css; document.head.appendChild(s);
    var d=document.createElement('div'); d.id='__p'; document.body.appendChild(d);
    var v=getComputedStyle(d).display; s.remove(); d.remove(); return v;
  }
  // CSS nesting: & .child inside a rule (Chrome 120+)
  var nested = probe('#__p{display:grid; &.x{display:flex}}');
  // @container query support
  var containerRule = probe('#__p{container-type:size;display:block} @container (orientation:portrait){#__p{display:flex}}');
  // container-type accepted?
  var ct = (function(){ var d=document.createElement('div'); d.style.containerType='size'; return d.style.containerType || '(rejected)' })();
  return JSON.stringify({
    nestedAmpersand: nested,          // Chrome 120+ -> grid ; Chrome 91 -> ?
    containerQueryApplied: containerRule,
    containerTypeAccepted: ct,
    supportsNesting: (function(){ try { return CSS.supports('&') } catch(e){ return 'throw' } })(),
    supportsLayer: (function(){ try { return CSS.supports('at-rule(@layer)') } catch(e){ return 'throw' } })()
  });
})()