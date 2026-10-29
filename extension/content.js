(() => {
  // A DOM node can survive extension reload even though its script context is dead.
  // Only this context's live instance is evidence that injection already succeeded.
  if (globalThis.__printChamberInstance?.isConnected) return;
  document.querySelectorAll('print-chamber-overlay,print-chamber-tray').forEach(node=>node.remove());
  const host = document.createElement('print-chamber-overlay');
  const root = host.attachShadow({mode: 'open'});
  const style = document.createElement('style'); style.textContent = PRINT_CHAMBER_CSS;
  root.append(style);
  const panel = document.createElement('section');
  panel.className = 'panel'; panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', '原画立体预览');
  panel.innerHTML = PRINT_CHAMBER_HTML;
  loadChamberFonts();
  root.append(panel); document.documentElement.append(host);
  globalThis.__printChamberInstance=host;
  const $ = s => root.querySelector(s);
  let source, candidate, candidatePoint, showTimer, hideTimer, version = 0, enabled = false, inside = false;
  let trigger='hover', currentResult, scale=.8, altHeld=false, pointerInside=false;
  const pinnedPrints=[], badges=[];
  const trayHost=document.createElement('print-chamber-tray');
  trayHost.style.cssText='display:block;position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2147483645';
  const trayRoot=trayHost.attachShadow({mode:'open'});
  const trayStyle=document.createElement('style');trayStyle.textContent=PRINT_CHAMBER_CSS+' .output-tray,.lightbox{pointer-events:auto}';trayRoot.append(trayStyle);document.documentElement.append(trayHost);
  async function preferences(){
    const v=await chrome.storage.local.get(['enabled','disabledSites','trigger']);
    enabled=v.enabled!==false && !(v.disabledSites||[]).includes(location.hostname);trigger=v.trigger||'hover';
    if(!enabled){close();trayHost.style.display='none'}else trayHost.style.display='block';
  }
  preferences();
  chrome.storage.onChanged.addListener(changes => {
    if (changes.enabled || changes.disabledSites || changes.trigger) preferences();
    if(changes.history){
      const records=new Map((changes.history.newValue||[]).map(r=>[r.sourceUrl,r]));
      const urls=new Set(records.keys());
      const removed=new Set((changes.history.oldValue||[]).filter(r=>!urls.has(r.sourceUrl)).map(r=>r.sourceUrl));
      let trayChanged=false;
      for(let i=pinnedPrints.length-1;i>=0;i--){
        const pinned=pinnedPrints[i],record=records.get(pinned.url);
        if(removed.has(pinned.url)){pinnedPrints.splice(i,1);trayChanged=true}
        else if(record && (pinned.recordId!==record.id || pinned.image!==record.image)){
          pinnedPrints[i]={...pinned,image:record.image,seconds:record.seconds,recordId:record.id};trayChanged=true;
        }
      }
      for(let i=badges.length-1;i>=0;i--)if(removed.has(badges[i].url)){badges[i].badge.remove();badges.splice(i,1)}
      if(removed.has(source?.url))close();
      if(removed.size||trayChanged){trayRoot.querySelector('.lightbox')?.remove();renderTray()}
    }
  });
  function close() {
    clearTimeout(showTimer); clearTimeout(hideTimer); version++; host.style.display = 'none';
    hideTimer = null; showTimer = null;
    source = null; candidate = null; inside = false;pointerInside=false;
    currentResult=null;highlight(null);
  }
  function cancelCandidate() {
    clearTimeout(showTimer);showTimer=null;candidate=null;candidatePoint=null;
  }
  function later() {
    clearTimeout(hideTimer);
    if (!inside) hideTimer = setTimeout(close, 650);
  }
  function place() {
    if (!source) return;
    const rect = source.element.getBoundingClientRect();
    scale=Math.min(.8,(innerWidth-24)/340,(innerHeight-24)/580);
    const width=340*scale,height=580*scale;
    panel.style.transform=`scale(${scale})`;host.style.width=width+'px';host.style.height=height+'px';
    let x = rect.right + 14;
    if (x + width > innerWidth - 12) x = rect.left - width - 14;
    x = Math.max(12, Math.min(x, innerWidth - width - 12));
    host.style.left = x + 'px'; host.style.top = Math.max(12, Math.min(rect.top-76*scale, innerHeight - height - 12)) + 'px';
  }
  let highlighted,oldOutline,oldOffset;
  function highlight(element){
    if(highlighted){highlighted.style.outline=oldOutline;highlighted.style.outlineOffset=oldOffset}
    highlighted=element;
    if(element){oldOutline=element.style.outline;oldOffset=element.style.outlineOffset;element.style.outline='2px solid #F4B53A';element.style.outlineOffset='3px'}
  }
  function state(name,caption){
    panel.className='panel '+name;
    const color=getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g);
    if(color && Number(color[3]??1)>0 && color.slice(0,3).reduce((a,n)=>a+Number(n),0)<350)panel.classList.add('dark');
    $('.lcd').textContent={feeding:'LOADING',printing:'PRINTING',revealing:'PRINT',ready:'DONE',error:'ERROR'}[name]||'READY';
    $('.caption').textContent=caption;
    $('.caption').removeAttribute('title');
    $('.retry').textContent=name==='waiting'?'打印':'重打';
    for(const button of root.querySelectorAll('.keys button'))button.disabled=name!=='ready';
    if(name==='error'||name==='waiting')$('.retry').disabled=false;
  }
  async function run(img, enteredAt = performance.now(), retry=false, confirmed=false) {
    const previousResult=source?.url===img.url?currentResult:null;
    clearTimeout(hideTimer); source = img; host.style.display = 'block';
    currentResult=null;$('.result').removeAttribute('src');
    state('checking','正在查找打印记录…');highlight(img.element);host.classList.add('appearing');
    place();
    const rect=img.element.getBoundingClientRect(),bounds=host.getBoundingClientRect();
    panel.style.setProperty('--fly-x',((rect.left+rect.width/2-bounds.left)/scale-167)+'px');
    panel.style.setProperty('--fly-y',((rect.top+rect.height/2-bounds.top)/scale-70)+'px');
    const ticket = ++version, started = performance.now();
    let printingTimer;
    try {
      let result = retry ? null : await chrome.runtime.sendMessage({type:'preview',url:img.url});
      if (ticket !== version) return;
      if (!retry && (!result || result.error)) throw new Error(result?.error || '连接已中断，请重试');
      if (result?.confirmationRequired && !confirmed) {
        state('waiting','点击「打印」后上传原画，云端生成可能计费');return;
      }
      if (retry || result.needsGeneration) {
        state('feeding','正在读取原画…');$('.ghost img').src=img.url;
        printingTimer=setTimeout(()=>{if(ticket===version)state('printing','图片等待生成 · 打印中')},700);
        let data;
        try {
          if (!(img.element instanceof HTMLImageElement)) throw new Error('Read background image through extension');
          const canvas = document.createElement('canvas');
          const factor = Math.min(1, 768 / Math.max(img.width, img.height));
          canvas.width = Math.round(img.width * factor); canvas.height = Math.round(img.height * factor);
          canvas.getContext('2d').drawImage(img.element, 0, 0, canvas.width, canvas.height);
          // Preserve alpha until the service applies the same white matte as URL downloads.
          data = canvas.toDataURL('image/png');
        } catch { /* Cross-origin images are fetched by the extension background. */ }
        result = await chrome.runtime.sendMessage({type:'generate',url:img.url,data,retry,confirmed});
      }
      clearTimeout(printingTimer);
      if (ticket !== version) return;
      if (!result || result.error) throw new Error(result?.error || '连接已中断，请重试');
      // The mode may have changed since lookup. The background still guards uploads.
      if (result.confirmationRequired) {
        state('waiting','点击「打印」后上传原画，云端生成可能计费');return;
      }
      $('.result').src = result.image;
      await $('.result').decode();
      if (ticket !== version) return;
      currentResult=result;
      const finish=()=>{
        if (ticket !== version) return;
        const cloud=result.provider && result.provider!=='local';
        state('ready',result.fromHistory?`历史打印 · ${cloud?'云端':'本地'}结果`:
          `${result.cached?'已打印':cloud?'云端打印':'本地打印'} · ${Number(result.seconds||((performance.now()-started)/1000)).toFixed(1)} 秒${result.historyError?' · 记录保存失败':''}`);
        if(result.fromHistory)$('.caption').title=[result.provider||'local',result.model].filter(Boolean).join(' · ');
        panel.dataset.totalMs = String(Math.round(performance.now() - enteredAt));
        markPrinted(img.element);
      };
      if(result.fromHistory){finish();return;}
      state('revealing','逐层打印中…');
      const revealStart=performance.now();
      function progress(){if(ticket!==version||!panel.classList.contains('revealing'))return;$('.lcd').textContent='PRINT '+Math.min(100,Math.round((performance.now()-revealStart)/6.5))+'%';requestAnimationFrame(progress)}
      progress();
      setTimeout(finish, matchMedia('(prefers-reduced-motion:reduce)').matches ? 0 : 660);
    } catch (error) {
      if (ticket !== version) return;
      if(previousResult){
        currentResult=previousResult;$('.result').src=previousResult.image;
        state('ready','重打失败 · '+error.message);
      }else state('error',error.message+' · 按「重打」重试');
    } finally {clearTimeout(printingTimer);}
  }
  const same = (a, b) => a && b && a.element === b.element && a.url === b.url;
  function describe(element) {
    if (!(element instanceof Element) || element === host) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) return null;
    if (element instanceof HTMLImageElement) {
      if (!element.complete || element.naturalWidth < 100 || element.naturalHeight < 100) return null;
      return {element, url: element.currentSrc || element.src, width: element.naturalWidth, height: element.naturalHeight};
    }
    if (element === document.body || element === document.documentElement) return null;
    const background = getComputedStyle(element).backgroundImage;
    const match = background.match(/^url\(["']?(.*?)["']?\)$/);
    return match ? {element, url: new URL(match[1], location.href).href, width: rect.width, height: rect.height} : null;
  }
  function findAt(x, y) {
    const stack = document.elementsFromPoint(x, y);
    if (stack.includes(host) || stack.includes(trayHost)) return null;
    for (const element of stack) {
      const direct = describe(element);
      if (direct) return direct;
      // Card overlays are often siblings of the image, rather than children of a link.
      if (element !== document.body && element !== document.documentElement) {
        for (const image of element.querySelectorAll('img')) {
          const rect = image.getBoundingClientRect();
          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            const found = describe(image); if (found) return found;
          }
        }
      }
    }
    return null;
  }
  function consider(img, keyboard=false) {
    if (!img) {
      cancelCandidate();
      if (!hideTimer) later();
      return;
    }
    clearTimeout(hideTimer); hideTimer = null;
    if (same(source, img) && host.style.display === 'block') {cancelCandidate();return}
    // A new image must be intentionally dwelled on. Moving across a card toward
    // the printer must not spend the same dwell time as resting on that image.
    const moved=source && point && candidatePoint && Math.hypot(point.x-candidatePoint.x,point.y-candidatePoint.y)>8;
    if (same(candidate, img) && !moved) return;
    clearTimeout(showTimer); candidate = img;
    candidatePoint=point?{...point}:null;
    const enteredAt = performance.now();
    showTimer = setTimeout(() => {
      if(!enabled || inside || !same(candidate,img) || (trigger==='alt'&&!altHeld))return;
      if(!keyboard && (!point || !same(findAt(point.x,point.y),img))){cancelCandidate();return}
      cancelCandidate();run(img,enteredAt);
    },trigger==='alt'?80:600);
  }
  let point, scheduled = false;
  function track(event) {
    if (!enabled) return;
    if (event.composedPath().includes(host) || event.composedPath().includes(trayHost)) {cancelCandidate();return}
    point = {x: event.clientX, y: event.clientY};
    altHeld=event.altKey;
    if(trigger==='alt'&&!altHeld){clearTimeout(showTimer);candidate=null;return}
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; if (enabled && !inside) consider(findAt(point.x, point.y)); });
  }
  document.addEventListener('pointermove', track, true);
  document.addEventListener('pointerover', track, true);
  document.addEventListener('load', event => {
    if (point && enabled && !inside && (trigger!=='alt'||altHeld) && event.target instanceof HTMLImageElement) consider(findAt(point.x, point.y));
  }, true);
  document.documentElement.addEventListener('pointerleave', () => { clearTimeout(showTimer); candidate = null; later(); });
  host.addEventListener('pointerenter', () => { pointerInside=true;inside = true; cancelCandidate();clearTimeout(hideTimer); });
  host.addEventListener('pointerleave', () => { pointerInside=false;inside = Boolean(root.activeElement); later(); });
  root.addEventListener('focusin', () => { inside = true; cancelCandidate();clearTimeout(hideTimer); });
  root.addEventListener('focusout', () => { queueMicrotask(()=>{inside=pointerInside||Boolean(root.activeElement);if(!inside)later()}); });
  $('.close').onclick = close;
  $('.pin').onclick = () => {if(currentResult){
    for(let i=pinnedPrints.length-1;i>=0;i--)if(pinnedPrints[i].url===source.url)pinnedPrints.splice(i,1);
    pinnedPrints.unshift({...currentResult,url:source.url});if(pinnedPrints.length>12)pinnedPrints.pop();renderTray();close();
  }};
  $('.retry').onclick = event => { if (source && event.isTrusted) run(source,performance.now(),!panel.classList.contains('waiting'),true); };
  $('.download').onclick = () => {if(currentResult){const a=document.createElement('a');a.href=currentResult.image;a.download='print-chamber.jpg';root.append(a);a.click();a.remove()}};
  $('.copy').onclick=async()=>{
    if(!currentResult)return;
    const button=$('.copy');button.disabled=true;
    try{const canvas=document.createElement('canvas');const img=$('.result');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;canvas.getContext('2d').drawImage(img,0,0);const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);button.textContent='已复制'}
    catch{$('.caption').textContent='复制失败，请用「下载」保存图片'}
    finally{button.disabled=false;setTimeout(()=>button.textContent='复制',1800)}
  };
  function markPrinted(element){
    const url=describe(element)?.url;
    const existing=badges.find(b=>b.element===element);
    if(existing){existing.url=url;placeBadges();return}
    const badge=document.createElement('span');badge.className='badge';badge.textContent='PRINTED';
    trayRoot.append(badge);badges.push({element,badge,url});
    if(badges.length>100)badges.shift().badge.remove();placeBadges();
  }
  function placeBadges(){
    for(const {element,badge,url} of badges){
      const r=element.getBoundingClientRect();
      badge.hidden=!element.isConnected||r.bottom<0||r.top>innerHeight||describe(element)?.url!==url;
      badge.style.left=(r.right-68)+'px';badge.style.top=(r.top+8)+'px';
    }
  }
  function showPhoto(image){
    const box=document.createElement('div');box.className='lightbox';box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-label','打印结果');
    const photo=document.createElement('img');photo.src=image;photo.alt='打印结果';const closeButton=document.createElement('button');closeButton.textContent='×';closeButton.setAttribute('aria-label','关闭');
    const dismiss=()=>{box.remove();trayRoot.querySelector('.tray-photo')?.focus()};closeButton.onclick=dismiss;box.onclick=e=>{if(e.target===box)dismiss()};box.onkeydown=e=>{if(e.key==='Escape')dismiss();if(e.key==='Tab'){e.preventDefault();closeButton.focus()}};box.append(photo,closeButton);trayRoot.append(box);closeButton.focus();
  }
  function renderTray(){
    trayRoot.querySelector('.output-tray')?.remove();if(!pinnedPrints.length)return;
    const tray=document.createElement('div');tray.className='output-tray';tray.innerHTML='<div class="tray-photos"></div><button class="tray-bar"><span class="tray-label">OUTPUT TRAY</span><span class="tray-count"></span></button><span class="tray-error" role="status"></span>';
    tray.querySelector('.tray-count').textContent=pinnedPrints.length+' PRINTS';tray.querySelector('.tray-bar').onclick=()=>chrome.runtime.sendMessage({type:'open-gallery'});
    pinnedPrints.slice(0,3).reverse().forEach((r,i)=>{
      const item=document.createElement('div');item.className='tray-item';item.style.left=[40,104,172][i]+'px';item.style.transform=`rotate(${[-9,4,11][i]}deg)`;
      const button=document.createElement('button');button.className='tray-photo';button.setAttribute('aria-label','放大打印结果');
      const img=document.createElement('img');img.src=r.image;img.alt='';button.append(img);button.onclick=()=>showPhoto(r.image);
      const remove=document.createElement('button');remove.className='delete-print';remove.textContent='×';remove.title='删除这张打印图片';remove.setAttribute('aria-label','删除这张打印图片');
      remove.onclick=async()=>{
        remove.disabled=true;
        try{
          const result=await chrome.runtime.sendMessage({type:'delete-history',sourceUrl:r.url});
          if(!result?.ok)throw new Error(result?.error||'删除失败，请重试');
          for(let n=pinnedPrints.length-1;n>=0;n--)if(pinnedPrints[n].url===r.url)pinnedPrints.splice(n,1);
          renderTray();trayRoot.querySelector('.delete-print')?.focus();
        }catch(error){remove.disabled=false;tray.querySelector('.tray-error').textContent=error.message}
      };
      item.append(button,remove);tray.querySelector('.tray-photos').append(item);
    });trayRoot.append(tray);
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') {close();trayRoot.querySelector('.lightbox')?.remove()}if(e.key==='Alt'){altHeld=true;if(trigger==='alt'&&point&&enabled&&!inside)consider(findAt(point.x,point.y))} });
  document.addEventListener('keyup',e=>{if(e.key==='Alt'){altHeld=false;if(trigger==='alt'){clearTimeout(showTimer);candidate=null}}});
  document.addEventListener('focusin', event => {
    if (!enabled || event.composedPath().includes(host) || event.composedPath().includes(trayHost) || (trigger==='alt'&&!altHeld)) return;
    const img = event.target instanceof HTMLImageElement ? event.target : event.target.closest?.('a')?.querySelector('img');
    const found = describe(img);
    if (found) consider(found,true);
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.type === 'chamber-ping') reply({active: true, enabled, version:chrome.runtime.getManifest().version,trigger});
  });
  window.addEventListener('resize', ()=>{place();placeBadges()});
  window.addEventListener('scroll', () => {place();placeBadges();}, {passive: true});
})();
