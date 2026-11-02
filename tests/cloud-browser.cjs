// Real extension + IndexedDB + DOM; provider HTTP is simulated, no live credentials.
const {test}=require('node:test');const assert=require('node:assert/strict');
const {chromium}=require('playwright');const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'..');
test('cloud settings, private keys, trial and explicit print with history reuse',async()=>{
 const profile=fs.mkdtempSync('/private/tmp/print-chamber-cloud-');
 const context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:require('./browser-options.cjs').executablePath,args:[`--disable-extensions-except=${root}/extension`,`--load-extension=${root}/extension`]});
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
  const image='data:image/png;base64,'+fs.readFileSync(require('./browser-options.cjs').fixture).toString('base64');
  await worker.evaluate(image=>{
   const original=fetch;globalThis.requests=[];globalThis.rejectNext=false;let polls=0;
   globalThis.fetch=async(url,o={})=>{
    const s=String(url);
    if(s.startsWith('https://api.minimax.cn/')||s.startsWith('https://api.minimax.io/')){
     requests.push({url:s,method:o.method,body:o.body});
     if(o.method==='GET')return new Response('{}',{status:405});
     const expected=s.includes('minimax.cn')?'fake-minimax-cn':'fake-minimax';
     if(o.headers.Authorization!=='Bearer '+expected)throw Error('MiniMax region key mismatch');
     return new Response(JSON.stringify({base_resp:{status_code:0},data:{image_base64:[image.split(',')[1]]}}));
    }
    if(s.startsWith('https://api.bfl.ai/')){
     requests.push({url:s,method:o.method,body:o.body});
     if(s.includes('/get_result')){if(o.headers['x-key']!=='fake-bfl')throw Error('missing BFL key');return new Response(JSON.stringify(++polls===1?{status:'Pending'}:{status:'Ready',result:{sample:'https://delivery.eu.bfl.ai/image.jpg'}}));}
     if(o.method==='GET')return new Response('{}',{status:405});
     return new Response(JSON.stringify({id:'fake-job',polling_url:'https://api.bfl.ai/v1/get_result?id=fake-job'}));
    }
    if(s==='https://delivery.eu.bfl.ai/image.jpg'){if(o.headers)throw Error('credentials leaked to delivery');return new Response(await(await original(image)).blob());}
    if(s.startsWith('https://ark.cn-beijing.volces.com/')||s.startsWith('https://generativelanguage.googleapis.com/')||s.includes('.maas.aliyuncs.com/')){
     requests.push({url:s,method:o.method,body:o.body});
     if(rejectNext){rejectNext=false;return new Response('credential must never be echoed',{status:401});}
     if(o.method==='GET')return new Response('{}',{status:s.includes('googleapis')?200:405});
     const b64=image.split(',')[1];
     const body=s.includes('googleapis')?{steps:[{type:'model_output',content:[{type:'image',data:b64,mime_type:'image/png'}]}]}:s.includes('maas.aliyuncs')?{output:{choices:[{message:{content:[{image:'https://test-results.aliyuncs.com/image.png'}]}}]}}:{data:[{b64_json:b64,output_format:'png'}]};
     return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
    }
    if(s==='https://test-results.aliyuncs.com/image.png')return new Response(await(await original(image)).blob());
    if(s.startsWith('https://cdna.artstation.com/'))return new Response(await(await original(image)).blob(),{headers:{'Content-Type':'image/png'}});
    if(s.startsWith('http://127.0.0.1:8877'))throw Error('Cloud mode must not contact local service');
    return original(url,o);
   };
  },image);
  const settings=await context.newPage();const errors=[];settings.on('pageerror',e=>errors.push(e.message));
  await settings.goto(`chrome-extension://${id}/settings.html`);await settings.selectOption('#mode','cloud');
  await worker.evaluate(()=>chrome.storage.local.set({generationMode:'cloud'}));
  const missingProvider = await settings.evaluate(()=>chrome.runtime.sendMessage({type:'cloud-check'}));
  assert.equal(missingProvider.error,'请先在生成设置中选择并保存云端供应商');
  assert.equal(await worker.evaluate(()=>requests.length),0);
  await worker.evaluate(()=>chrome.storage.local.remove('generationMode'));
  await settings.check('#consent');
  for(const provider of ['minimax-cn','minimax','bfl','volc','ali','google']){
   await settings.selectOption('#provider',provider);await settings.fill('#key',`fake-${provider}`);
   assert.equal(await settings.locator('#provider-region-note').isVisible(),provider.startsWith('minimax'));
   assert.match(await settings.locator('#cloud-check-help').innerText(),provider==='google'?/查询所选模型/:/仅检查接口可达性/);
   if(provider==='ali')await settings.fill('#workspace','test-workspace');
   await settings.click('#check');await settings.waitForFunction(()=>document.querySelector('#notice').textContent.includes('未验证'));
   assert.equal(await settings.inputValue('#key'),'');
   const before=await worker.evaluate(()=>requests.filter(r=>r.method==='POST').length);
   await settings.setInputFiles('#file',require('./browser-options.cjs').fixture);
   settings.once('dialog',d=>d.accept());await settings.click('#trial');await settings.waitForFunction(()=>document.querySelector('#notice').textContent.includes('实际生成通过'));
   assert.equal(await worker.evaluate(()=>requests.filter(r=>r.method==='POST').length),before+1);
   assert.ok(await settings.locator('#preview').isVisible());
   if(provider.startsWith('minimax'))assert.match(await settings.locator('#provider-notice').innerText(),/效果未验证/);
   assert.ok(!(await worker.evaluate(()=>chrome.storage.local.get(null))).key);
   assert.ok(!JSON.stringify(await worker.evaluate(()=>chrome.storage.local.get(null))).includes('fake-'));
  }
  await settings.reload();await settings.waitForFunction(()=>document.querySelector('#verification').textContent.includes('曾生成成功'));
  assert.equal(await settings.inputValue('#key'),'');
  await settings.selectOption('#model','gemini-3.1-flash-image');await settings.click('#save-settings');
  await settings.waitForFunction(()=>document.querySelector('#notice').textContent.includes('已启用'));
  assert.match(await settings.locator('#verification').innerText(),/尚未/);
  await worker.evaluate(()=>{rejectNext=true;});await settings.click('#check');await settings.waitForFunction(()=>document.querySelector('#notice').textContent.includes('密钥无效'));
  await settings.screenshot({path:path.join(root,'output/cloud-settings.png'),fullPage:true});
  const source='https://www.artstation.com/cloud-regression';
  await context.route(source,r=>r.fulfill({contentType:'text/html',body:'<body style="padding:80px"><img id="art" width="240" height="360" src="https://cdna.artstation.com/cloud.png"></body>'}));
  await context.route('https://cdna.artstation.com/cloud.png',r=>r.fulfill({contentType:'image/png',body:fs.readFileSync(require('./browser-options.cjs').fixture)}));
  const posts=await worker.evaluate(()=>requests.filter(r=>r.method==='POST').length);
  const page=await context.newPage();await page.goto(source);await page.locator('#art').hover();
  const host=page.locator('print-chamber-overlay');await host.locator('.panel.waiting').waitFor({timeout:5000});await host.hover();
  assert.equal(await host.locator('.retry').innerText(),'打印');
  await page.waitForTimeout(900);
  assert.equal(await worker.evaluate(()=>requests.filter(r=>r.method==='POST').length),posts,'hover must not call a paid endpoint');
  await host.locator('.retry').click();await host.locator('.panel.ready').waitFor({timeout:15000});
  assert.equal(await worker.evaluate(()=>requests.filter(r=>r.method==='POST').length),posts+1);
  assert.match(await host.locator('.caption').innerText(),/云端打印/);
  const storage=await worker.evaluate(()=>chrome.storage.local.get(null));assert.equal(storage.history.length,1);assert.equal(storage.history[0].provider,'google');assert.equal(storage.token,undefined);
  assert.equal(storage.history[0].promptHash.length,64);
  await page.reload();await page.locator('#art').hover();await host.locator('.panel.ready').waitFor({timeout:5000});await host.hover();
  assert.match(await host.locator('.caption').innerText(),/历史打印/);
  assert.equal(await worker.evaluate(()=>requests.filter(r=>r.method==='POST').length),posts+1);
  assert.deepEqual((await worker.evaluate(()=>chrome.storage.local.get('history'))).history,storage.history,'viewing must not rewrite records');
  await worker.evaluate(()=>{rejectNext=true});await host.locator('.retry').click();
  await page.waitForFunction(()=>document.querySelector('print-chamber-overlay').shadowRoot.querySelector('.caption').textContent.includes('重打失败'));
  assert.equal(await host.locator('.result').getAttribute('src'),storage.history[0].image);
  assert.deepEqual((await worker.evaluate(()=>chrome.storage.local.get('history'))).history,storage.history);
  // Web-page content scripts cannot call privileged settings messages.
  const denied=await worker.evaluate(async(tabId)=>{
   const result=await chrome.scripting.executeScript({target:{tabId},func:()=>chrome.runtime.sendMessage({type:'cloud-load'})});return result[0].result;
  },(await worker.evaluate(()=>chrome.tabs.query({url:'https://www.artstation.com/cloud-regression'})))[0].id);
  assert.match(denied.error,/仅设置页面/);
  await settings.locator('summary').filter({hasText:'密钥与使用说明'}).click();
  await settings.click('#forget');await settings.waitForFunction(()=>document.querySelector('#notice').textContent.includes('密钥已删除'));
  assert.equal(await settings.inputValue('#mode'),'local');
  assert.equal((await worker.evaluate(()=>chrome.storage.local.get('generationMode'))).generationMode,'local');
  await page.reload();await page.locator('#art').hover();await host.locator('.panel.ready').waitFor({timeout:5000});
  assert.match(await host.locator('.caption').innerText(),/历史打印.*云端/,'history retains its origin after changing modes and deleting credentials');
  assert.equal(await worker.evaluate(()=>requests.filter(r=>r.method==='POST').length),posts+2);
  assert.deepEqual(errors,[]);
 }finally{await context.close();fs.rmSync(profile,{recursive:true,force:true});}
});
