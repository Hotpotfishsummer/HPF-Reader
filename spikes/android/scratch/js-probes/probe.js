JSON.stringify({
  text: document.body.innerText.slice(0,140).replace(/\n/g,' | '),
  iframes: document.querySelectorAll('iframe').length,
  fv: (function(){var f=document.querySelector('foliate-view');return f?{w:f.offsetWidth,h:f.offsetHeight}:null})(),
  innerH: innerHeight, innerW: innerWidth,
  layerWorks: (function(){var s=document.createElement('style');s.textContent='@layer q{.zz{color:rgb(9,9,9)}}';document.head.appendChild(s);var d=document.createElement('div');d.className='zz';document.body.appendChild(d);var v=getComputedStyle(d).color;s.remove();d.remove();return v})()
})