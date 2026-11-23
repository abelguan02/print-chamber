const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {chromium}=require('playwright');
const {id}=require('../native/identity.cjs');
const {executablePath,fixture}=require('./browser-options.cjs');

test('Codex one-click login, failures, explicit printing and history', {skip:process.platform!=='darwin'},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'print-chamber-test-'));
  const ext=path.join(dir,'extension');
  const name='com.printchamber.test_fixture';
  const statusFile=path.join(dir,'fixture-mode');
  const calls=path.join(dir,'calls');
  const host=path.join(dir,'host');
  const registry=path.join(dir,'NativeMessagingHosts');
  const image='data:image/png;base64,'+await fs.readFile(fixture,'base64');
  const fixtureCopy=path.join(dir,'artwork.png');
  let ctx;
  try{
    await fs.copyFile(fixture,fixtureCopy);
    await fs.cp(path.resolve(__dirname,'../extension'),ext,{recursive:true});
    const bridge=path.join(ext,'codex.js');
    const code=await fs.readFile(bridge,'utf8');
    assert.ok(code.includes("'com.printchamber.codex'"));
    await fs.writeFile(bridge,code.replace("'com.printchamber.codex'",JSON.stringify(name)));

    const origin='chrome-extension://'+id+'/';
    await fs.mkdir(registry);
    await fs.writeFile(path.join(registry,name+'.json'),JSON.stringify({name,description:'test fixture',path:host,type:'stdio',allowed_origins:[origin]}));
    await fs.writeFile(statusFile,'ok');
    await fs.writeFile(host,'#!'+process.execPath+'\n'+
      `const fs=require('node:fs');const {serve}=require(${JSON.stringify(require.resolve('../native/host.cjs'))});
       const {preparePrint}=require(${JSON.stringify(require.resolve('../native/operation.cjs'))});
       serve(process.stdin,process.stdout,async request=>{
        fs.appendFileSync(${JSON.stringify(calls)},request.type+'\\n');
        const mode=fs.readFileSync(${JSON.stringify(statusFile)},'utf8');
        if(request.type==='hello')return {appVersion:'0.3.0',extensionVersion:'0.3.0'};
        if(request.type==='local-token')return {token:null};
        if(request.type==='detect')return mode==='absent'?{found:false,source:null,version:null}:{found:true,source:'standalone',version:'codex-cli 0.0.1'};
        if(mode==='exit')process.exit(0);
        if(mode==='signed-out')throw Error('未登录 Codex');
        if(request.type==='connect')return {connected:true,source:'standalone',version:'codex-cli 0.0.1'};
        if(request.confirmed!==true||!request.data.startsWith('data:image/'))throw Error('Invalid print');
        const image=await preparePrint(${JSON.stringify(dir)},{outputImage:'artwork.png',width:256,height:384});
        return {image,model:'test',provider:'codex',seconds:5.75};
       }).finally(()=>process.stdin.destroy());`,{mode:0o700});
    ctx=await chromium.launchPersistentContext(dir,{headless:true,executablePath,env:{...process.env, HOME:dir},args:['--disable-extensions-except='+ext,'--load-extension='+ext]});
    await ctx.route('http://127.0.0.1:8877/health',route=>route.fulfill({json:{ready:true,failed:false,busy:false}}));
    const worker=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');
    assert.equal(new URL(worker.url()).host,id);
    await worker.evaluate(image=>{
      const original=fetch;
      globalThis.fetch=async(url,options)=>String(url)==='https://cdna.artstation.com/pc-test.png'?new Response(await (await original(image)).blob()):original(url,options);
    },image);
    const popup=await ctx.newPage();
    await popup.goto(origin+'popup.html');
    assert.equal(await popup.locator('#codex-connect').count(),0);
    const refused=await popup.evaluate(()=>chrome.runtime.sendMessage({type:'codex-connect'}));
    assert.match(refused.error,/仅设置页面/);
    const registration=path.join(registry,name+'.json');
    const settings=await ctx.newPage();
    await fs.rename(registration,registration+'.off');
    await settings.goto(origin+'settings.html');
    const ready=()=>settings.waitForFunction(()=>!document.querySelector('#fields').disabled);
    await ready();
    assert.equal(await settings.locator('option[value=codex]').count(),0);
    await fs.rename(registration+'.off',registration);
    await fs.writeFile(statusFile,'absent');await settings.reload();await ready();
    assert.equal(await settings.locator('option[value=codex]').count(),0);
    await fs.writeFile(statusFile,'ok');await settings.reload();await ready();
    await settings.selectOption('#mode','codex');
    assert.equal(await settings.locator('.hint, details, .consent, #codex-fields p').count(),0);
    assert.equal(await settings.locator('button:visible').count(),1);
    const usageDialog='Codex 生成会把原画发送给 OpenAI，并消耗你的 Codex 额度。继续？';
    for(const accept of [false,true]){
      let prompt;
      settings.once('dialog',async dialog=>{prompt=dialog.message();await (accept?dialog.accept():dialog.dismiss());});
      await settings.click('#codex-connect');
      await settings.waitForFunction(s=>document.querySelector('#notice').textContent===s,accept?'已连接 · 独立版':'已取消');
      assert.equal(prompt,usageDialog);
      const state=await worker.evaluate(()=>chrome.storage.local.get(['generationMode','codexUsageAcknowledged','codexInstallation']));
      assert.equal(state.generationMode,accept?'codex':undefined);
      assert.equal(state.codexUsageAcknowledged,accept?true:undefined);
      if(accept)assert.equal(state.codexInstallation.source,'standalone');
      else assert.ok(!(await fs.readFile(calls,'utf8')).includes('connect'));
    }
    await settings.selectOption('#mode','local');
    await settings.click('#save-settings');
    await settings.waitForFunction(()=>document.querySelector('#notice').textContent==='请先填写本地连接码');
    assert.equal((await worker.evaluate(()=>chrome.storage.local.get('generationMode'))).generationMode,'codex');
    await settings.fill('#local-token','fixture-local');
    await settings.click('#save-settings');
    await settings.waitForFunction(()=>document.querySelector('#notice').textContent==='已保存');
    await settings.reload();await ready();await settings.selectOption('#mode','codex');
    for(const [mode,expected] of [['signed-out','未登录 Codex'],['exit','中断'],['ok','已连接']]){
      await fs.writeFile(statusFile,mode);
      await settings.click('#codex-connect');
      await settings.waitForFunction(s=>document.querySelector('#notice').textContent.includes(s),expected);
      const saved=await worker.evaluate(async()=>(await chrome.storage.local.get('generationMode')).generationMode);
      assert.equal(saved,mode==='ok'?'codex':'local');
    }
    await settings.screenshot({path:path.resolve(__dirname,'../output/codex-settings-03.png')});
    const source='https://www.artstation.com/artwork/pc-test';
    await ctx.route(source,r=>r.fulfill({contentType:'text/html',body:'<body style="padding:80px"><img id="art" width="240" height="360" src="https://cdna.artstation.com/pc-test.png"></body>'}));
    await ctx.route('https://cdna.artstation.com/pc-test.png',r=>r.fulfill({contentType:'image/png',path:fixture}));
    const page=await ctx.newPage();await page.emulateMedia({reducedMotion:'no-preference'});await page.goto(source);await page.locator('#art').hover();
    const overlay=page.locator('print-chamber-overlay');await overlay.locator('.panel.waiting').waitFor();await overlay.hover();
    assert.equal((await fs.readFile(calls,'utf8')).trim().split('\n').filter(x=>x==='generate').length,0);
    assert.equal(await overlay.locator('.caption').innerText(),'点击「打印」生成');
    await overlay.locator('.retry').click();await overlay.locator('.panel.ready').waitFor();
    const history=await worker.evaluate(async()=>(await chrome.storage.local.get('history')).history);
    assert.equal(history.length,1);assert.equal(history[0].provider,'codex');
    assert.ok(history[0].image.startsWith('data:image/jpeg;base64,'));
    assert.deepEqual(await overlay.locator('.result').evaluate(img=>[img.naturalWidth,img.naturalHeight]),[256,384]);
    assert.equal(history[0].model,'test');assert.equal(Object.hasOwn(history[0],'timings'),false);
    await page.reload();await page.locator('#art').hover();await overlay.locator('.panel.ready').waitFor();
    assert.equal((await fs.readFile(calls,'utf8')).trim().split('\n').filter(x=>x==='generate').length,1);
  }finally{if(ctx)await ctx.close();await fs.rm(dir,{recursive:true,force:true});}
});
