const {test}=require('node:test');const assert=require('node:assert/strict');
const {chromium}=require('playwright');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
test('Local setup: first use, state checks, shared token persistence and cloud mode isolation',async()=>{
 const root=path.resolve(__dirname,'..'),profile=await fs.mkdtemp(path.join(os.tmpdir(),'local-settings-'));
 let context;
 try{
  context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:require('./browser-options.cjs').executablePath,args:[`--disable-extensions-except=${root}/extension`,`--load-extension=${root}/extension`]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const base='chrome-extension://'+new URL(worker.url()).host;
  await require('./browser-options.cjs').mockAbsentCodex(worker);
  let healthRequests=0;
  await context.route('http://127.0.0.1:8877/health',r=>{healthRequests++;return r.fulfill({contentType:'application/json',body:'{"ready":true,"failed":false,"busy":false}'});});
  const popup=await context.newPage();const errors=[];popup.on('pageerror',e=>errors.push(e.message));
  await popup.goto(base+'/popup.html');
  await popup.waitForFunction(()=>document.querySelector('a[href="settings.html"]').hidden);
  await popup.locator('#token').waitFor();
  assert.equal(await popup.locator('#help-text').count(),0);
  assert.equal(await popup.locator('#recent .empty').innerText(),'暂无打印记录');
  assert.equal(await popup.locator('#save').innerText(),'打开生成设置');
  assert.equal(healthRequests,0,'First use must not attempt a local connection');
  const [page]=await Promise.all([context.waitForEvent('page'),popup.click('#save')]);
  page.on('pageerror',e=>errors.push(e.message));
  await page.waitForURL(base+'/settings.html');await page.waitForFunction(()=>document.querySelector('#local-status').textContent.includes('未配置'));
  await page.waitForFunction(()=>!document.querySelector('#fields').disabled);
  assert.equal(await page.inputValue('#mode'),'cloud');
  assert.equal((await worker.evaluate(()=>chrome.storage.local.get('generationMode'))).generationMode,undefined);
  await page.selectOption('#mode','local');
  assert.equal(await page.locator('.hint, details, .consent').count(),0);
  await page.click('#local-check');assert.equal(await page.locator('#local-status').innerText(),'未配置');
  await worker.evaluate(()=>chrome.storage.local.set({generationMode:'cloud'}));
  await page.click('#save-settings');
  await page.waitForFunction(()=>document.querySelector('#notice').textContent==='请先填写本地连接码');
  assert.deepEqual(await worker.evaluate(()=>chrome.storage.local.get(['generationMode','token'])),{generationMode:'cloud'});
  await popup.waitForFunction(()=>document.querySelector('#status').textContent==='云端 · 未验证');
  await worker.evaluate(()=>chrome.storage.local.set({cloudVerified:true}));
  await popup.waitForFunction(()=>document.querySelector('#status').textContent==='云端 · 已验证');
  await page.fill('#local-token','test-local-only');
  await page.evaluate(()=>{window.healthCase='ready';window.fetch=async(url,options)=>{
   if(url!=='http://127.0.0.1:8877/health'||options.headers.Authorization!=='Bearer test-local-only')throw Error('Unexpected request');
   if(healthCase==='offline')throw TypeError('Failed to fetch');
   if(healthCase==='timeout')throw new DOMException('timeout','TimeoutError');
   if(healthCase==='body-timeout'){
    return new Response(new ReadableStream({start(controller){
     options.signal.addEventListener('abort',()=>controller.error(new DOMException('aborted','AbortError')),{once:true});
    }}));
   }
   if(healthCase==='unauthorized')return new Response('{}',{status:401});
   if(healthCase==='http')return new Response('{}',{status:500});
   if(healthCase==='invalid')return new Response('{}');
   if(healthCase==='invalid-json')return new Response('<html>');
   return new Response(JSON.stringify({ready:healthCase!=='loading',failed:healthCase==='failed',busy:healthCase==='busy'}));
  }});
  for(const [state,expected] of [
   ['ready','已就绪'],['loading','模型加载中'],['busy','模型忙碌'],['failed','模型加载失败 · 查看小助手日志'],
   ['unauthorized','连接码不匹配'],['http','服务异常 · HTTP 500'],
   ['invalid','不是兼容的本地服务'],['invalid-json','不是兼容的本地服务'],
   ['offline','服务未启动 · 在小助手中启动'],['timeout','连接超时'],['body-timeout','连接超时']
  ]){
   await page.evaluate(s=>window.healthCase=s,state);await page.click('#local-check');
   await page.waitForFunction(()=>!document.querySelector('#fields').disabled);
   assert.equal(await page.locator('#local-status').innerText(),expected);
   assert.equal(await page.locator('#notice').innerText(),'','The local result has one status location');
  }
  assert.equal((await worker.evaluate(()=>chrome.storage.local.get('token'))).token,undefined);
  assert.equal((await worker.evaluate(()=>chrome.storage.local.get('generationMode'))).generationMode,'cloud');
  await page.click('#save-settings');await page.waitForFunction(()=>document.querySelector('#notice').textContent==='已保存');
  assert.deepEqual(await worker.evaluate(()=>chrome.storage.local.get(['token','generationMode'])),{token:'test-local-only',generationMode:'local'});
  assert.equal(await page.inputValue('#local-token'),'');
  await page.reload();await page.waitForFunction(()=>document.querySelector('#local-key-state').textContent.includes('已保存'));
  await page.waitForFunction(()=>document.querySelector('#mode').value==='local');
  assert.equal(await page.locator('#local-status').innerText(),'尚未检查');
  await popup.reload();await popup.locator('#dashboard').waitFor();
  await popup.waitForFunction(()=>document.querySelector('#dashboard-lcd').textContent==='READY');
  await popup.locator('#connection-led').click();
  assert.equal(context.pages().filter(p=>p.url()===base+'/settings.html').length,1);
  assert.equal(await popup.locator('#token').isVisible(),false);
  await page.selectOption('#mode','cloud');assert.equal(await page.locator('#local-note').isVisible(),false);
  assert.equal(await page.locator('#cloud-fields').isVisible(),true);
  // Legacy users may have a token but no explicit generationMode.
  await worker.evaluate(()=>chrome.storage.local.remove('generationMode'));
  await page.reload();await page.waitForFunction(()=>document.querySelector('#mode').value==='local');
  assert.equal((await worker.evaluate(()=>chrome.storage.local.get('token'))).token,'test-local-only');
  for(const width of [320,768,1024,1440]){
   await page.setViewportSize({width,height:900});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Local page overflow at '+width);
   await page.selectOption('#mode','cloud');
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Cloud page overflow at '+width);
   await page.selectOption('#mode','local');
  }
  await page.setViewportSize({width:1100,height:900});
  await page.click('#local-check');
  await page.waitForFunction(()=>document.querySelector('#local-status').textContent==='已就绪');
  await page.screenshot({path:path.join(root,'output/settings-local.png'),fullPage:true});
  await page.selectOption('#mode','cloud');
  assert.ok(await page.evaluate(()=>document.querySelector('#save-settings').getBoundingClientRect().top<document.querySelector('#trial-section').getBoundingClientRect().top));
  assert.deepEqual(errors,[]);
 }finally{await context?.close();await fs.rm(profile,{recursive:true,force:true});}
});
