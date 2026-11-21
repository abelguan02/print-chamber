// Real extension + IndexedDB + DOM; provider HTTP is simulated, no live credentials.
const {test}=require('node:test');const assert=require('node:assert/strict');
const {chromium}=require('playwright');const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'..');
test('cloud settings, private keys, trial and explicit print with history reuse',async()=>{
 const profile=fs.mkdtempSync('/private/tmp/print-chamber-cloud-');
 const context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:require('./browser-options.cjs').executablePath,args:[`--disable-extensions-except=${root}/extension`,`--load-extension=${root}/extension`]});
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
  await require('./browser-options.cjs').mockAbsentCodex(worker);
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
  await settings.goto(`chrome-extension://${id}/settings.html`);
  await settings.waitForFunction(()=>!document.querySelector('#fields').disabled);
  await settings.selectOption('#mode','cloud');
  await worker.evaluate(()=>chrome.storage.local.set({generationMode:'cloud'}));
  const missingProvider = await settings.evaluate(()=>chrome.runtime.sendMessage({type:'cloud-check'}));
  assert.equal(missingProvider.error,'请先在生成设置中选择并保存云端供应商');
  assert.equal(await worker.evaluate(()=>requests.length),0);
  await worker.evaluate(()=>chrome.storage.local.remove('generationMode'));
  const fixture=require('./browser-options.cjs').fixture;
  const chargeMessage='云端生成会上传原画到所选供应商，并按次计费。继续？';
  const dialogs=[];
  let acceptNext=false;
  settings.on('dialog',async dialog=>{
   dialogs.push([dialog.type(),dialog.message()]);
   if(acceptNext){acceptNext=false;await dialog.accept();}
   else await dialog.dismiss();
  });
  async function completeAction(button){
   await settings.click(button);
   await settings.waitForFunction(()=>!document.querySelector('#fields').disabled);
  }
  const billingState=()=>worker.evaluate(()=>chrome.storage.local.get(['cloudChargeAcknowledged','generationMode','cloudProvider']));
  const publicConfig=()=>settings.evaluate(()=>chrome.runtime.sendMessage({type:'cloud-load'}));
  const providers=['minimax-cn','minimax','bfl','volc','ali','google'];
  await settings.selectOption('#provider',providers[0]);
  assert.equal(await settings.evaluate(()=>document.querySelectorAll('.hint, details, .consent').length),0);
  assert.equal(await settings.locator('#verification').isVisible(),false);
  assert.equal(await settings.locator('#forget').isVisible(),false);
  await settings.fill('#key','fake-minimax-cn');
  await settings.setInputFiles('#file',fixture);
  const initialConfig=await publicConfig();
  const initialBillingState=await billingState();
  for(const button of ['#save-settings','#check','#trial']){
   const count=dialogs.length;
   await completeAction(button);
   assert.deepEqual(dialogs.slice(count),[['confirm',chargeMessage]],button);
   assert.equal(await settings.locator('#notice').innerText(),'已取消');
   assert.deepEqual(await billingState(),initialBillingState);
   assert.deepEqual(await publicConfig(),initialConfig);
   assert.equal(await worker.evaluate(()=>requests.length),0);
  }
  acceptNext=true;
  await completeAction('#save-settings');
  assert.deepEqual(dialogs,Array(4).fill(['confirm',chargeMessage]));
  assert.deepEqual(await billingState(),{cloudChargeAcknowledged:true,generationMode:'cloud',cloudProvider:providers[0]});
  assert.equal(await settings.locator('#notice').innerText(),'已启用云端生成');
  assert.equal(await settings.locator('#forget').isVisible(),true);
  await completeAction('#save-settings');
  assert.equal(await settings.locator('#notice').innerText(),'已启用云端生成');
  await settings.setInputFiles('#file',[]);
  await settings.setViewportSize({width:1100,height:900});
  await settings.screenshot({path:path.join(root,'output/settings-cloud.png'),fullPage:true});
  await settings.reload();
  await settings.locator('#forget').waitFor();
  for(const provider of providers){
   await settings.selectOption('#provider',provider);
   if(provider!==providers[0])await settings.fill('#key',`fake-${provider}`);
   if(provider==='ali')await settings.fill('#workspace','test-workspace');
   const requestsBefore=await worker.evaluate(()=>requests.length);
   await completeAction('#check');
   assert.equal(await worker.evaluate(()=>requests.length),requestsBefore+1);
   assert.equal(await settings.locator('#notice').innerText(),provider==='google'?'模型查询通过':'接口可达');
   assert.equal(await settings.inputValue('#key'),'');
   assert.equal(await settings.locator('#verification').isVisible(),false);
   const before=await worker.evaluate(()=>requests.filter(r=>r.method==='POST').length);
   await settings.setInputFiles('#file',fixture);
   await completeAction('#trial');
   assert.match(await settings.locator('#notice').innerText(),/^生成完成 · \d+\.\d 秒$/);
   assert.equal(await worker.evaluate(()=>requests.filter(r=>r.method==='POST').length),before+1);
   assert.ok(await settings.locator('#preview').isVisible());
   assert.match(await settings.locator('#verification').innerText(),/^上次生成成功 · .+/);
   assert.ok(!(await worker.evaluate(()=>chrome.storage.local.get(null))).key);
   assert.ok(!JSON.stringify(await worker.evaluate(()=>chrome.storage.local.get(null))).includes('fake-'));
  }
  assert.equal(dialogs.length,4,'Repeated saves, checks and trials must reuse the confirmation across reloads');
  await settings.reload();await settings.locator('#verification').waitFor();
  assert.match(await settings.locator('#verification').innerText(),/^上次生成成功 · .+/);
  assert.equal(await settings.inputValue('#key'),'');
  await settings.selectOption('#model','gemini-3.1-flash-image');
  assert.equal(await settings.locator('#verification').isVisible(),false);
  await completeAction('#save-settings');
  assert.equal(await settings.locator('#verification').isVisible(),false);
  await worker.evaluate(()=>{rejectNext=true;});await completeAction('#check');
  assert.match(await settings.locator('#notice').innerText(),/密钥无效/);
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
  await completeAction('#forget');
  assert.equal(await settings.locator('#notice').innerText(),'密钥已删除');
  assert.equal((await billingState()).cloudChargeAcknowledged,true,'Other suppliers still have keys');
  assert.equal(await settings.inputValue('#mode'),'local');
  assert.equal((await worker.evaluate(()=>chrome.storage.local.get('generationMode'))).generationMode,'local');
  await page.reload();await page.locator('#art').hover();await host.locator('.panel.ready').waitFor({timeout:5000});
  assert.match(await host.locator('.caption').innerText(),/历史打印.*云端/,'history retains its origin after changing modes and deleting credentials');
  assert.equal(await worker.evaluate(()=>requests.filter(r=>r.method==='POST').length),posts+2);
  await settings.selectOption('#mode','cloud');
  assert.equal(await settings.locator('#forget').isVisible(),false);
  for(const provider of providers.filter(id=>id!=='google')){
   await settings.selectOption('#provider',provider);
   assert.equal((await billingState()).cloudChargeAcknowledged,true);
   assert.equal(await settings.locator('#forget').isVisible(),true);
   await completeAction('#forget');
   assert.equal(await settings.locator('#notice').innerText(),'密钥已删除');
   await settings.selectOption('#mode','cloud');
   assert.equal(await settings.locator('#forget').isVisible(),false);
  }
  assert.equal(dialogs.length,4);
  assert.equal((await billingState()).cloudChargeAcknowledged,undefined);
  await settings.reload();
  await settings.waitForFunction(()=>!document.querySelector('#fields').disabled);
  await settings.selectOption('#mode','cloud');
  await settings.selectOption('#provider','google');
  await settings.fill('#key','fake-google');
  acceptNext=true;
  await completeAction('#check');
  assert.deepEqual(dialogs.slice(4),[['confirm',chargeMessage]]);
  assert.equal((await billingState()).cloudChargeAcknowledged,true);
  assert.equal(await settings.locator('#forget').isVisible(),true);
  assert.deepEqual(errors,[]);
 }finally{await context.close();fs.rmSync(profile,{recursive:true,force:true});}
});
