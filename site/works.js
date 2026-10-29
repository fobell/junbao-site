/* JUNBAO · Works & cases
   Shared by index.html and ai.html: any element with [data-works] becomes the works board.

   To add a work, append one entry to WORKS (order = display order):
     video  src (file played and downloaded), poster, loop (optional muted preview), ar ("w/h"), dur, size, file (download name)
     music  src, secs, size, file, peaks (optional list of 0–100 levels for the waveform)
     site   url, thumb (optional screenshot, about 3:2), hue (cover colour when there is no thumb)
     app    reserved: the Apps tab and marquee word appear automatically once an app entry exists.
   Text fields take {zh, en}. */
(function(){
'use strict';

var WORKS=[
  {type:'video',ar:'1600/686',src:'media/oct7.mp4',loop:'media/oct7-loop.mp4',poster:'media/oct7-poster.jpg',dur:'1′35″',size:'14 MB',file:'JUNBAO-October-7.mp4',
   title:{zh:'《10月7日》',en:'October 7'},
   meta:{zh:'AI 短片 · 为北京世青国际学校 AI 课程创作 · 本人主演',en:'AI short film · made for the BWYA AI class · starring myself'}},
  {type:'video',ar:'9/16',src:'media/demo2.mp4',loop:'media/demo2-loop.mp4',poster:'media/demo2-poster.jpg',dur:'29″',size:'2.3 MB',file:'JUNBAO-vertical-AI-short.mp4',
   title:{zh:'竖屏 AI 短片',en:'Vertical AI short'},
   meta:{zh:'AI 分身出镜 · 动态字幕',en:'AI double on camera · kinetic captions'}},
  {type:'music',src:'media/i-love-ib.mp3',secs:80.2,size:'2.5 MB',file:'JUNBAO - I Love IB.mp3',
   title:{zh:'I Love IB',en:'I Love IB'},
   meta:{zh:'AI 音乐 Demo · 可在线试听，也可下载',en:'AI music demo · stream it here or download it'},
   peaks:[0,0,0,0,0,3,23,37,38,69,68,54,71,67,59,53,73,42,78,66,55,69,55,46,62,65,43,75,72,77,80,76,76,38,33,46,47,42,38,34,35,32,31,35,35,37,33,36,42,61,60,59,73,57,54,51,40,33,61,42,60,46,33,50,49,46,55,37,37,58,40,58,55,60,42,56,42,63,42,44,61,45,61,53,42,48,61,45,69,41,39,61,47,68,65,64,46,69,45,67,35,35,39,39,34,33,34,40,37,42,35,37,31,27,36,43,44,49,53,57,44,68,45,37,35,34,48,45,43,44,35,35,48,43,43,43,32,45,42,47,48,58,54,69,70,43,49,44,58,87,81,88,46,54,69,80,83,72,77,64,80,81,100,92,90,81,65,32,31,33,34,32,0,0,0,0,0,0,0,0]},
  {type:'site',url:'https://prompt.junbao.ai',thumb:'img/site-prompt.jpg',
   title:{zh:'人物提示词工作台',en:'Character Prompt Studio'},
   meta:{zh:'整理真人、动漫、3D 角色设定，生成主流创作平台可直接使用的提示词。',en:'Define live-action, anime or 3D characters and get prompts ready for the major creative platforms.'}},
  {type:'site',url:'https://laurelume.com',hue:38,
   title:{zh:'Laurelume',en:'Laurelume'},
   meta:{zh:'全球 AI 电影节、品牌征集与创作基金信息，对照官方来源核对截止日期与规则。',en:'AI film festivals, brand calls and creative funding, checked against official sources.'}},
  {type:'site',url:'https://dramarabbit.com',hue:350,
   title:{zh:'DramaRabbit',en:'DramaRabbit'},
   meta:{zh:'面向北美观众的独立短剧指南，追踪 7 个平台的上新与免费集数。',en:'An independent short-drama guide for North America, tracking seven platforms.'}}
];

var TYPES=[
  {k:'all',zh:'全部',en:'All',word:''},
  {k:'video',zh:'视频',en:'Video',word:'VIDEO'},
  {k:'music',zh:'音乐',en:'Music',word:'MUSIC'},
  {k:'site',zh:'网站',en:'Web',word:'WEB'},
  {k:'app',zh:'应用',en:'Apps',word:'APPS'}
];

var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var EASE='cubic-bezier(.2,.7,.2,1)';
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function L(t){return '<span class="zh">'+esc(t.zh)+'</span><span class="en">'+esc(t.en==null?t.zh:t.en)+'</span>'}
function pad2(n){return(n<10?'0':'')+n}
function host(u){return u.replace(/^https?:\/\//,'').replace(/\/$/,'')}
function mmss(s){s=Math.max(0,Math.floor(s||0));return Math.floor(s/60)+':'+pad2(s%60)}
var I={
  play:'<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
  pause:'<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z"/></svg>',
  dl:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>',
  out:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>'
};

/* every player on the page: starting one stops the others */
var players=[];
function stopOthers(me){players.forEach(function(p){if(p!==me)p.pause()})}

function videoCard(w,n){
  var p=w.ar.split('/'),ar=p[0]/p[1],tall=ar<1;
  return '<article class="wk-card wk-video'+(tall?' wk-tall':'')+'" data-type="video" style="--ar:'+ar.toFixed(4)+'">'+
    '<div class="wk-media" style="aspect-ratio:'+w.ar+'">'+
      '<img class="wk-poster" src="'+w.poster+'" alt="" loading="lazy">'+
      (w.loop?'<video class="wk-prev" muted loop playsinline preload="none" data-src="'+w.loop+'" aria-hidden="true"></video>':'')+
      '<video class="wk-full" playsinline preload="none" data-src="'+w.src+'"></video>'+
      '<button class="wk-play" type="button" aria-label="播放 Play: '+esc(w.title.en)+'"><span class="wk-ring" aria-hidden="true"></span>'+I.play+'</button>'+
      '<span class="wk-badge">VIDEO · '+(tall?'9:16':'2.35:1')+' · '+w.dur+'</span>'+
    '</div>'+
    '<div class="wk-info"><span class="wk-no">'+pad2(n)+'</span><div class="wk-txt"><h3 class="wk-t">'+L(w.title)+'</h3><p class="wk-m">'+L(w.meta)+'</p></div>'+
      '<a class="wk-dl" href="'+w.src+'" download="'+esc(w.file)+'">'+I.dl+'<span class="zh">下载</span><span class="en">Download</span><small>MP4 · '+w.size+'</small></a></div>'+
  '</article>';
}

function musicCard(w,n){
  var bars='';(w.peaks||[]).forEach(function(v){bars+='<i style="--v:'+Math.max(6,v)+'%"></i>'});
  return '<article class="wk-card wk-music" data-type="music">'+
    '<div class="wk-cover"><canvas aria-hidden="true"></canvas><span class="wk-cover-k" aria-hidden="true">JUNBAO<br>AI MUSIC</span><span class="wk-cover-n" aria-hidden="true">'+pad2(n)+'</span></div>'+
    '<div class="wk-mbody">'+
      '<span class="wk-badge">MUSIC · AI DEMO · '+mmss(w.secs).replace(':','′')+'″</span>'+
      '<h3 class="wk-t wk-big">'+L(w.title)+'</h3>'+
      '<p class="wk-m">'+L(w.meta)+'</p>'+
      '<div class="wk-wave" role="slider" tabindex="0" aria-label="播放进度 Seek" aria-valuemin="0" aria-valuemax="'+Math.round(w.secs)+'" aria-valuenow="0" aria-valuetext="0:00">'+
        '<div class="wk-bars">'+bars+'</div><div class="wk-bars wk-lit" aria-hidden="true">'+bars+'</div><span class="wk-head" aria-hidden="true"></span><span class="wk-hover" aria-hidden="true"></span></div>'+
      '<div class="wk-ctrl">'+
        '<button class="wk-pp" type="button" aria-label="播放 Play: '+esc(w.title.en)+'">'+I.play+'</button>'+
        '<span class="wk-time"><b>0:00</b> / '+mmss(w.secs)+'</span>'+
        '<a class="wk-dl" href="'+w.src+'" download="'+esc(w.file)+'">'+I.dl+'<span class="zh">下载</span><span class="en">Download</span><small>MP3 · '+w.size+'</small></a>'+
      '</div>'+
      '<audio preload="none" src="'+w.src+'"></audio>'+
    '</div>'+
  '</article>';
}

function siteCard(w,n){
  var h=host(w.url),shot;
  if(w.thumb)shot='<div class="wk-shot"><img src="'+w.thumb+'" alt="'+esc(w.title.zh)+' 首页截图 homepage" loading="lazy"></div>';
  else shot='<div class="wk-gen" style="--h:'+(w.hue||190)+'" aria-hidden="true"><span class="wk-orb a"></span><span class="wk-orb b"></span><b>'+esc(w.title.en)+'</b><em>'+esc(h)+'</em></div>';
  return '<a class="wk-card wk-site" data-type="site" href="'+w.url+'" target="_blank" rel="noopener">'+
    '<div class="wk-frame"><div class="wk-chrome" aria-hidden="true"><i></i><i></i><i></i><span>'+esc(h)+'</span></div>'+shot+'</div>'+
    '<div class="wk-info"><span class="wk-no">'+pad2(n)+'</span><div class="wk-txt"><h3 class="wk-t">'+L(w.title)+'</h3><p class="wk-m">'+L(w.meta)+'</p>'+
    '<span class="wk-url">'+esc(h)+I.out+'</span></div></div>'+
  '</a>';
}

function build(root){
  var count={all:WORKS.length};WORKS.forEach(function(w){count[w.type]=(count[w.type]||0)+1});
  var types=TYPES.filter(function(t){return count[t.k]});
  var words=types.filter(function(t){return t.word});
  var mq='';for(var r=0;r<4;r++)words.forEach(function(t){mq+='<span data-t="'+t.k+'">'+t.word+'</span><i>✦</i>'});
  var tabs=types.map(function(t,i){return '<button type="button" role="tab" data-f="'+t.k+'" aria-selected="'+(i===0)+'">'+L(t)+'<sup>'+pad2(count[t.k])+'</sup></button>'}).join('');
  var cards='',n=0;
  WORKS.forEach(function(w){n++;cards+=w.type==='video'?videoCard(w,n):w.type==='music'?musicCard(w,n):w.type==='site'?siteCard(w,n):''});
  root.innerHTML='<div class="wk-marquee" aria-hidden="true"><div class="wk-mq">'+mq+'</div></div>'+
    '<div class="wk-bar"><div class="wk-tabs" role="tablist" aria-label="作品分类 Filter works">'+tabs+'<span class="wk-ind" aria-hidden="true"></span></div>'+
    '<span class="wk-total"><b>'+pad2(count.all)+'</b><span class="zh">件作品，持续更新</span><span class="en">works, and counting</span></span></div>'+
    '<div class="wk-grid">'+cards+'</div>';
  root.classList.add('wk');
  wireTabs(root);
  root.querySelectorAll('.wk-video').forEach(wireVideo);
  root.querySelectorAll('.wk-music').forEach(wireMusic);
  root.querySelectorAll('.wk-site').forEach(wireTilt);
  reveal(root);
}

function wireTabs(root){
  var tabs=[].slice.call(root.querySelectorAll('.wk-tabs button')),ind=root.querySelector('.wk-ind'),
      cards=[].slice.call(root.querySelectorAll('.wk-card')),mq=root.querySelector('.wk-marquee');
  function place(b){ind.style.width=b.offsetWidth+'px';ind.style.transform='translateX('+b.offsetLeft+'px)'}
  function pick(b,focus){
    var f=b.getAttribute('data-f');
    tabs.forEach(function(t){var on=t===b;t.setAttribute('aria-selected',String(on));t.tabIndex=on?0:-1});
    place(b);if(focus)b.focus();
    mq.setAttribute('data-on',f);
    var first=new Map();cards.forEach(function(c){if(!c.hidden)first.set(c,c.getBoundingClientRect())});
    cards.forEach(function(c){var on=f==='all'||c.getAttribute('data-type')===f;if(!on&&!c.hidden)c.dispatchEvent(new Event('wk:hide'));c.hidden=!on});
    if(reduce||!cards[0].animate)return;
    var i=0;cards.forEach(function(c){
      if(c.hidden)return;var a=first.get(c),b2=c.getBoundingClientRect();
      if(!a)c.animate([{opacity:0,transform:'translateY(36px) scale(.96)'},{opacity:1,transform:'none'}],{duration:650,delay:60*i++,easing:EASE,fill:'backwards'});
      else c.animate([{transform:'translate('+(a.left-b2.left)+'px,'+(a.top-b2.top)+'px)'},{transform:'none'}],{duration:600,easing:EASE});
    });
  }
  tabs.forEach(function(b,i){
    b.tabIndex=i===0?0:-1;
    b.addEventListener('click',function(){pick(b)});
    b.addEventListener('keydown',function(e){var d=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;if(d){e.preventDefault();pick(tabs[(i+d+tabs.length)%tabs.length],true)}});
  });
  mq.setAttribute('data-on','all');
  function re(){var b=root.querySelector('.wk-tabs [aria-selected="true"]');if(b)place(b)}
  window.addEventListener('resize',re);
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(re);
  new MutationObserver(re).observe(document.documentElement,{attributes:true,attributeFilter:['class']});
  re();
}

function wireVideo(card){
  var prev=card.querySelector('.wk-prev'),full=card.querySelector('.wk-full'),btn=card.querySelector('.wk-play'),me;
  me={pause:function(){if(!full.paused)full.pause()}};players.push(me);
  if(prev&&!reduce&&'IntersectionObserver' in window){
    new IntersectionObserver(function(es){es.forEach(function(e){
      if(card.classList.contains('wk-on'))return;
      if(e.isIntersecting){if(!prev.src)prev.src=prev.getAttribute('data-src');var p=prev.play();if(p&&p.catch)p.catch(function(){});prev.classList.add('wk-live')}
      else prev.pause();
    })},{threshold:.25}).observe(card);
  }
  btn.addEventListener('click',function(){
    stopOthers(me);
    if(!full.src)full.src=full.getAttribute('data-src');
    full.controls=true;card.classList.add('wk-on');if(prev)prev.pause();
    var p=full.play();if(p&&p.catch)p.catch(function(){});
  });
  full.addEventListener('play',function(){stopOthers(me)});
  card.addEventListener('wk:hide',function(){me.pause();if(prev)prev.pause()});
}

function wireMusic(card){
  var a=card.querySelector('audio'),pp=card.querySelector('.wk-pp'),wave=card.querySelector('.wk-wave'),
      time=card.querySelector('.wk-time b'),cv=card.querySelector('canvas'),ctx=cv.getContext('2d'),
      total=+wave.getAttribute('aria-valuemax')||1,an=null,data=null,raf=0,me;
  me={pause:function(){if(!a.paused)a.pause()}};players.push(me);
  function dur(){return isFinite(a.duration)&&a.duration>0?a.duration:total}
  function sync(){
    var t=a.currentTime||0,p=Math.min(1,t/dur());
    wave.style.setProperty('--p',(p*100).toFixed(3)+'%');
    time.textContent=mmss(t);
    wave.setAttribute('aria-valuenow',Math.round(t));wave.setAttribute('aria-valuetext',mmss(t));
  }
  function setIcon(){var on=!a.paused;pp.innerHTML=on?I.pause:I.play;pp.setAttribute('aria-label',(on?'暂停 Pause':'播放 Play')+': I Love IB');card.classList.toggle('wk-playing',on)}
  function analyser(){
    if(an||reduce)return;
    try{var AC=window.AudioContext||window.webkitAudioContext;var ac=new AC();var s=ac.createMediaElementSource(a);an=ac.createAnalyser();an.fftSize=256;an.smoothingTimeConstant=.82;s.connect(an);an.connect(ac.destination);data=new Uint8Array(an.frequencyBinCount);an._ac=ac}catch(e){an=null}
  }
  pp.addEventListener('click',function(){
    if(a.paused){stopOthers(me);analyser();if(an&&an._ac.state==='suspended')an._ac.resume();var p=a.play();if(p&&p.catch)p.catch(function(){})}
    else a.pause();
  });
  a.addEventListener('play',function(){stopOthers(me);setIcon();loop()});
  a.addEventListener('pause',setIcon);
  a.addEventListener('ended',function(){a.currentTime=0;sync();setIcon()});
  a.addEventListener('timeupdate',sync);
  a.addEventListener('loadedmetadata',sync);
  function seekTo(x){var r=wave.getBoundingClientRect(),p=Math.min(1,Math.max(0,(x-r.left)/r.width));if(a.readyState===0){a.load()}var go=function(){a.currentTime=p*dur();sync()};if(a.readyState>0)go();else a.addEventListener('loadedmetadata',go,{once:true});wave.style.setProperty('--p',(p*100)+'%')}
  var drag=false;
  wave.addEventListener('pointerdown',function(e){drag=true;wave.setPointerCapture(e.pointerId);seekTo(e.clientX)});
  wave.addEventListener('pointermove',function(e){var r=wave.getBoundingClientRect(),p=Math.min(1,Math.max(0,(e.clientX-r.left)/r.width));wave.style.setProperty('--hv',(p*100)+'%');wave.querySelector('.wk-hover').textContent=mmss(p*dur());if(drag)seekTo(e.clientX)});
  wave.addEventListener('pointerup',function(){drag=false});
  wave.addEventListener('keydown',function(e){var d=e.key==='ArrowRight'?5:e.key==='ArrowLeft'?-5:0;if(e.key===' '||e.key==='Enter'){e.preventDefault();pp.click();return}if(d){e.preventDefault();a.currentTime=Math.min(dur(),Math.max(0,(a.currentTime||0)+d));sync()}});
  card.addEventListener('wk:hide',function(){me.pause()});

  /* cover: a radial spectrum ring that listens while playing and breathes while idle */
  var W=0,H=0,dpr=Math.min(2,window.devicePixelRatio||1),t0=performance.now(),visible=true;
  function size(){var r=cv.getBoundingClientRect();W=Math.max(1,r.width);H=Math.max(1,r.height);cv.width=W*dpr;cv.height=H*dpr;draw(performance.now())}
  function draw(now){
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,H);
    var cx=W/2,cy=H/2,R=Math.min(W,H)*.26,N=72,t=(now-t0)/1000,playing=!a.paused;
    if(an&&playing)an.getByteFrequencyData(data);
    var g=ctx.createLinearGradient(0,H,W,0);g.addColorStop(0,'#7CC8D8');g.addColorStop(1,'#E3A04A');
    ctx.strokeStyle=g;ctx.lineCap='round';ctx.lineWidth=Math.max(2,R*.045);
    for(var i=0;i<N;i++){
      var ang=i/N*Math.PI*2-Math.PI/2,v;
      if(an&&playing){var k=Math.floor(Math.pow(((i<N/2?i:N-i)/(N/2)),1.4)*data.length*.7);v=data[k]/255}
      else v=.18+.12*Math.sin(t*1.6+i*.45)+.06*Math.sin(t*.7-i*.9)+(playing?.25*Math.abs(Math.sin(t*4+i)):0);
      var len=R*(.12+v*.95),x1=cx+Math.cos(ang)*R,y1=cy+Math.sin(ang)*R;
      ctx.globalAlpha=.35+v*.65;ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(cx+Math.cos(ang)*(R+len),cy+Math.sin(ang)*(R+len));ctx.stroke();
    }
    ctx.globalAlpha=1;ctx.lineWidth=1;ctx.strokeStyle='rgba(241,236,227,.22)';
    ctx.beginPath();ctx.arc(cx,cy,R*.82,0,Math.PI*2);ctx.stroke();
    var p=Math.min(1,(a.currentTime||0)/dur());
    ctx.strokeStyle='#F1ECE3';ctx.lineWidth=2;ctx.beginPath();ctx.arc(cx,cy,R*.82,-Math.PI/2,-Math.PI/2+p*Math.PI*2);ctx.stroke();
    ctx.fillStyle='#F1ECE3';ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.font='500 '+Math.max(9,Math.round(R*.11))+'px "IBM Plex Mono",monospace';ctx.fillText('I  L O V E',cx,cy-R*.3);
    ctx.font='italic 900 '+Math.round(R*.58)+'px "Bodoni Moda",serif';ctx.fillText('IB',cx,cy+R*.12);
  }
  function loop(){cancelAnimationFrame(raf);(function f(now){draw(now);if(visible&&(!reduce||!a.paused))raf=requestAnimationFrame(f)})(performance.now())}
  if('IntersectionObserver' in window)new IntersectionObserver(function(es){visible=es[0].isIntersecting;if(visible&&!reduce)loop();else cancelAnimationFrame(raf)}).observe(cv);
  window.addEventListener('resize',size);
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(size);
  size();sync();
}

function wireTilt(card){
  if(reduce||!window.matchMedia('(hover:hover) and (pointer:fine)').matches)return;
  card.addEventListener('pointermove',function(e){var r=card.getBoundingClientRect(),x=(e.clientX-r.left)/r.width-.5,y=(e.clientY-r.top)/r.height-.5;
    card.style.setProperty('--rx',(-y*7).toFixed(2)+'deg');card.style.setProperty('--ry',(x*9).toFixed(2)+'deg');card.style.setProperty('--mx',((x+.5)*100).toFixed(1)+'%');card.style.setProperty('--my',((y+.5)*100).toFixed(1)+'%')});
  card.addEventListener('pointerleave',function(){card.style.setProperty('--rx','0deg');card.style.setProperty('--ry','0deg')});
}

function reveal(root){
  var cards=[].slice.call(root.querySelectorAll('.wk-card'));
  if(reduce||!('IntersectionObserver' in window)){cards.forEach(function(c){c.classList.add('wk-in')});return}
  cards.forEach(function(c){c.classList.add('wk-wait')});
  var io=new IntersectionObserver(function(es){
    var k=0;es.forEach(function(e){if(!e.isIntersecting)return;var c=e.target;c.style.setProperty('--d',(k++*110)+'ms');c.classList.add('wk-in');io.unobserve(c)});
  },{rootMargin:'0px 0px -4% 0px'});
  cards.forEach(function(c){io.observe(c)});
}

document.querySelectorAll('[data-works]').forEach(build);
})();
