(async function(){
  try {
    var assets = Array.prototype.map.call(document.querySelectorAll('script[src]'), function(s){ return s.src });
    var links  = Array.prototype.map.call(document.querySelectorAll('link[href]'), function(l){ return l.href });
    return JSON.stringify({ assets: assets, links: links, fvExists: !!document.querySelector('foliate-view'), href: location.href });
  } catch (e) { return JSON.stringify({err:String(e)}) }
})()