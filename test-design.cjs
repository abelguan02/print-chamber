const {chromium}=require('playwright');
const fs=require('fs');const assert=require('node:assert/strict');
(async()=>{
 const profile=fs.mkdtempSync('/private/tmp/print-chamber-design-');
 const context=await chromium.launchPersistentContext(profile,{headless:true,viewport:{width:1440,height:1000},executablePath:require('./tests/browser-options.cjs').executablePath,args:[`--disable-extensions-except=${__dirname}/extension`,`--load-extension=${__dirname}/extension`]});
 try{
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
 const result='data:image/png;base64,'+fs.readFileSync(require('./tests/browser-options.cjs').fixture).toString('base64');
 await worker.evaluate(async image=>{
  await chrome.storage.local.clear();await chrome.storage.local.set({token:'test',enabled:true});
  const original=fetch;globalThis.generateCount=0;
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(CLOUD_PROMPT));
  const promptHash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  globalThis.fetch=async(url,options)=>{
   if(typeof url==='string'&&url.startsWith('https://cdna.artstation.com/')){
    const response=new Response(await (await original(image)).blob(),{headers:{'Content-Type':'image/png'}});
    Object.defineProperty(response,'url',{value:url});return response;
   }
   if(url==='http://127.0.0.1:8877/generate'){globalThis.generateCount++;await new Promise(r=>setTimeout(r,1800));return new Response(JSON.stringify(options.headers.Authorization==='Bearer test'?{image,seconds:2.46,width:432,height:768,promptHash}:{error:'连接码无效'}),{status:options.headers.Authorization==='Bearer test'?200:401,headers:{'Content-Type':'application/json'}})}
   return original(url,options);
  };
 },result);
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const source='https://www.artstation.com/chamber-design-test';
 await context.route(source,r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><title>角色原画 · 设计验收</title><style>body{background:#161616;margin:0;padding:100px 50px;display:flex;gap:60px}img{width:240px;height:390px;object-fit:cover}</style><a href="#"><img id="art" src="https://cdna.artstation.com/test.jpg"></a><img id="second" src="https://cdna.artstation.com/second.jpg">`}));
 await context.route('https://cdna.artstation.com/*.jpg',r=>r.fulfill({contentType:'image/png',body:fs.readFileSync(require('./tests/browser-options.cjs').fixture)}));
 await page.goto(source);const host=page.locator('print-chamber-overlay');
 await page.locator('#art').hover();await page.waitForTimeout(300);assert(!await host.isVisible(),'600ms hover delay');await host.waitFor({state:'visible'});await host.hover();
 await host.locator('.panel.printing').waitFor();await page.screenshot({path:'output/new-printing.png'});
 await host.locator('.panel.ready').waitFor({timeout:10000}).catch(async e=>{console.log(await host.locator('.panel').evaluate(el=>({state:el.className,text:el.innerText,host:el.getRootNode().host.style.cssText})));await page.screenshot({path:'output/test-failure.png'});throw e});await page.screenshot({path:'output/new-ready.png'});
 const box=await host.boundingBox();assert.equal(Math.round(box.width),272);assert.equal(Math.round(box.height),464);
 assert.equal(await host.locator('.lcd').innerText(),'DONE');assert.equal(await host.locator('.keys button').count(),4);
 const beforeCrossing=await worker.evaluate(()=>generateCount);
 await page.locator('#second').hover({position:{x:230,y:100}});
 await page.waitForTimeout(180);
 await host.locator('.download').hover();
 await page.waitForTimeout(900);
 assert.equal(await worker.evaluate(()=>generateCount),beforeCrossing,'Entering printer must cancel a pending image switch');
 assert.equal(await host.locator('.lcd').innerText(),'DONE','Printer controls must keep their current image');
 await page.locator('#second').evaluate(el=>el.style.transform='translateX(300px)');
 for(const x of [670,710,750,790,830]){await page.mouse.move(x,220);await page.waitForTimeout(160)}
 assert.equal(await worker.evaluate(()=>generateCount),beforeCrossing,'Moving across another image must not switch until the pointer rests');
 await host.locator('.download').hover();
 await page.locator('#second').evaluate(el=>el.style.transform='');
 await page.waitForTimeout(650);
 assert.equal(await worker.evaluate(()=>generateCount),beforeCrossing,'Canceled switch must stay canceled');
 if(process.argv.includes('--hover-only')){
   await page.locator('#second').hover({position:{x:230,y:100}});
   await page.waitForTimeout(700);await host.hover();await host.locator('.panel.ready').waitFor();
   assert.equal(await worker.evaluate(()=>generateCount),beforeCrossing+1,'Resting on another image must still switch normally');
   const report={passed:true,tests:['entering printer cancels pending switch','moving across another image does not switch','resting on another image switches normally']};
   fs.writeFileSync('output/hover-interaction-test.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));return;
 }
 if(process.argv.includes('--deletion-only')){
   await host.locator('.pin').click();
   await worker.evaluate(async()=>{const {history}=await chrome.storage.local.get('history');await chrome.storage.local.set({history:[{...history[0],id:'second-record',sourceUrl:'https://cdna.artstation.com/second.jpg',title:'Second print'},...history]})});
   const gallery=await context.newPage();await gallery.goto(`chrome-extension://${id}/gallery.html`);
   await gallery.locator('#records article').nth(1).waitFor();
   const popup=await context.newPage();await popup.route('http://127.0.0.1:8877/health',r=>r.fulfill({contentType:'application/json',body:'{"ready":true}'}));await popup.goto(`chrome-extension://${id}/popup.html`);
   await popup.locator('#recent a').nth(1).waitFor();
   await page.bringToFront();await page.locator('print-chamber-tray .tray-photo').hover();
   await page.screenshot({path:'output/tray-delete.png'});
   await page.locator('print-chamber-tray .delete-print').click();
   await page.locator('print-chamber-tray .output-tray').waitFor({state:'detached'});
   await gallery.waitForFunction(()=>document.querySelectorAll('#records article').length===1);
   await popup.waitForFunction(()=>document.querySelectorAll('#recent a').length===1);
   assert.equal(await page.locator('print-chamber-tray .lightbox').count(),0,'Delete must not enlarge the photo');
   await gallery.reload();await gallery.locator('#records article').waitFor();assert.equal(await gallery.locator('#records article').count(),1,'Deletion survives reload');
   await gallery.locator('#records article').hover();await gallery.screenshot({path:'output/gallery-delete.png',fullPage:true});
   await gallery.locator('.delete-record').click();await gallery.locator('#records .empty').waitFor();
   await popup.waitForFunction(()=>document.querySelectorAll('#recent a').length===0);
   assert.deepEqual(await worker.evaluate(async()=>(await chrome.storage.local.get('history')).history),[]);
   assert.equal(await gallery.locator('#hero-printer .lcd').innerText(),'READY');
   await page.bringToFront();await page.mouse.move(0,0);await page.locator('#art').hover();await host.waitFor({state:'visible'});await host.hover();await host.locator('.panel.ready').waitFor();
   assert.equal(await worker.evaluate(async()=>(await chrome.storage.local.get('history')).history.length),1,'Printing again after deletion must save a new record rather than reuse a deleted cache entry');
   assert.deepEqual(errors,[]);
   const report={passed:true,tests:['tray delete','gallery delete','popup synchronization','last item hides tray','empty history state','persistence after reload','delete does not open image','printing deleted URL saves a new record']};
   fs.writeFileSync('output/delete-test.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));return;
 }
 console.log('Ready state verified; checking download');
 const download=page.waitForEvent('download',{timeout:10000});await host.locator('.download').click();assert.equal((await download).suggestedFilename(),'print-chamber.jpg');
 await host.locator('.copy').click();await page.waitForTimeout(300);assert.equal(await host.locator('.copy').innerText(),'已复制');
 const before=await worker.evaluate(()=>generateCount);await host.locator('.retry').click();await host.locator('.panel.ready').waitFor();assert.equal(await worker.evaluate(()=>generateCount),before+1,'Retry submits again');
 await host.locator('.pin').click();assert(!await host.isVisible());assert.equal(await page.locator('print-chamber-tray .tray-photo').count(),1);await page.waitForTimeout(400);await page.screenshot({path:'output/new-tray.png'});
 await page.locator('print-chamber-tray .tray-photo').click();await page.locator('print-chamber-tray .lightbox').waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('print-chamber-tray .lightbox').count(),0);
 await worker.evaluate(()=>chrome.storage.local.set({trigger:'alt'}));await page.mouse.move(0,0);await page.locator('#second').hover();await page.waitForTimeout(750);assert(!await host.isVisible(),'Alt mode ignores ordinary hover');await page.keyboard.down('Alt');await host.waitFor({state:'visible'});await page.keyboard.up('Alt');await host.hover();await host.locator('.panel.ready').waitFor();await page.keyboard.press('Escape');
 await worker.evaluate(()=>chrome.storage.local.set({disabledSites:['www.artstation.com']}));await page.mouse.move(0,0);await page.keyboard.down('Alt');await page.locator('#art').hover();await page.waitForTimeout(750);assert(!await host.isVisible(),'Site switch disables');await page.keyboard.up('Alt');
 await worker.evaluate(()=>chrome.storage.local.set({disabledSites:[],trigger:'hover',token:'wrong'}));await page.reload();await page.locator('#second').evaluate(el=>el.src='https://cdna.artstation.com/uncached.jpg');await page.locator('#second').hover();await host.waitFor({state:'visible'});await host.hover();await host.locator('.panel.error').waitFor();await page.screenshot({path:'output/new-error.png'});assert((await host.locator('.caption').innerText()).includes('连接码'));assert(await host.locator('.pin').isDisabled());assert(!await host.locator('.retry').isDisabled());await page.keyboard.press('Escape');
 await page.setViewportSize({width:390,height:700});await page.locator('#art').hover();await host.waitFor({state:'visible'});await host.locator('.panel.ready').waitFor();const narrow=await host.boundingBox();assert(narrow.x>=0&&narrow.x+narrow.width<=390&&narrow.y+narrow.height<=700);assert.match(await host.locator('.caption').innerText(),/历史打印/);await page.screenshot({path:'output/new-narrow.png'});
 // Saved prints remain viewable with invalid credentials.
 await page.keyboard.press('Escape');await page.mouse.move(0,0);
 const popup=await context.newPage();popup.on('pageerror',e=>errors.push(e.message));await worker.evaluate(()=>chrome.storage.local.set({token:''}));await page.bringToFront();await popup.goto(`chrome-extension://${id}/popup.html`);await popup.setViewportSize({width:360,height:650});await popup.locator('#setup').waitFor();await popup.screenshot({path:'output/new-setup.png'});assert.equal(await popup.locator('#token').isVisible(),false);
 const [settings]=await Promise.all([context.waitForEvent('page'),popup.locator('#save').click()]);await settings.waitForURL(`chrome-extension://${id}/settings.html`);await settings.waitForFunction(()=>!document.querySelector('#first-use-note').hidden);await settings.selectOption('#mode','local');await settings.locator('#local-token').fill('test');await settings.locator('#save-settings').click();await settings.waitForFunction(()=>document.querySelector('#notice').textContent&&!document.querySelector('#fields').disabled);assert.match(await settings.locator('#notice').innerText(),/已保存本地配置/);
 await popup.route('http://127.0.0.1:8877/health',r=>r.fulfill({contentType:'application/json',body:'{"ready":true}'}));await popup.reload();await popup.locator('#dashboard').waitFor();await popup.screenshot({path:'output/new-dashboard.png'});assert.equal(await popup.locator('#recent a').count(),2);await popup.locator('[data-trigger=alt]').click();assert.equal(await worker.evaluate(async()=>(await chrome.storage.local.get('trigger')).trigger),'alt');
 const gallery=await context.newPage();gallery.on('pageerror',e=>errors.push(e.message));await gallery.route('http://127.0.0.1:8877/health',r=>r.fulfill({contentType:'application/json',body:'{"ready":true}'}));await gallery.goto(`chrome-extension://${id}/gallery.html`);await gallery.locator('#records article').first().waitFor();await gallery.screenshot({path:'output/new-gallery.png',fullPage:true});assert.equal(await gallery.locator('#records article').count(),2);await gallery.locator('[data-filter=Behance]').click();assert.equal(await gallery.locator('#records article').count(),0);await gallery.locator('[data-filter=all]').click();await gallery.locator('.picture').first().click();assert(await gallery.locator('#detail').isVisible());await gallery.keyboard.press('Escape');
 // Visual fixture uses the exact gradient placeholder from the supplied printer board.
 await gallery.evaluate(()=>{const p=document.querySelector('#hero-printer');document.body.replaceChildren(p);document.body.style.background='white';p.className='panel ready';p.style.visibility='visible';p.querySelector('.result').style.display='none';p.querySelector('.print-sheet').style.background='radial-gradient(ellipse at 38% 28%, #FFE6EE 0%, #F0B8C9 18%, #C2507F 52%, #4A1D38 100%)';p.querySelector('.caption').textContent='本地打印 · 3.8 秒 · 来自 @[作者名]'});
 await gallery.evaluate(()=>document.fonts.ready);await gallery.locator('.panel').screenshot({path:'output/new-reference-comparison.png'});
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,tests:['hover delay','loading and printing','download','copy','retry','pin to tray','enlargement','Alt trigger','site disable','auth error','small viewport','connection panel','recent prints','gallery filters','gallery detail','no script errors'],generation:'controlled fixture; not an inference benchmark'}));
 }finally{await context.close();fs.rmSync(profile,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
