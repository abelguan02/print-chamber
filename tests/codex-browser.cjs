const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {chromium}=require('playwright');
const {extensionId}=require('../native/install.cjs');
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
  let ctx;
  try{
    await fs.cp(path.resolve(__dirname,'../extension'),ext,{recursive:true});
    const bridge=path.join(ext,'codex.js');
    const code=await fs.readFile(bridge,'utf8');
    assert.ok(code.includes("'com.printchamber.codex'"));
    await fs.writeFile(bridge,code.replace("'com.printchamber.codex'",JSON.stringify(name)));
    const id=extensionId(ext);
    const origin='chrome-extension://'+id+'/';
    await fs.mkdir(registry);
    await fs.writeFile(path.join(registry,name+'.json'),JSON.stringify({name,description:'test fixture',path:host,type:'stdio',allowed_origins:[origin]}));
    await fs.writeFile(host,'#!'+process.execPath+'\n'+
      `const fs=require('node:fs');const {serve}=require(${JSON.stringify(require.resolve('../native/host.cjs'))});
       serve(process.stdin,process.stdout,async request=>{
        fs.appendFileSync(${JSON.stringify(calls)},request.type+'\\n');
        const mode=fs.readFileSync(${JSON.stringify(statusFile)},'utf8');
        if(mode==='exit')process.exit(0);
        if(mode==='signed-out')throw Error('本次连接未识别到已有登录');
        if(request.type==='connect')return {connected:true};
        if(request.confirmed!==true||!request.data.startsWith('data:image/'))throw Error('Invalid print');
        return {image:${JSON.stringify(image)},model:'test',provider:'codex',seconds:1};
       }).finally(()=>process.stdin.destroy());`,{mode:0o700});
    ctx=await chromium.launchPersistentContext(dir,{headless:true,executablePath,args:['--disable-extensions-except='+ext,'--load-extension='+ext]});
    const worker=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');
    assert.equal(new URL(worker.url()).host,id);
    await worker.evaluate(image=>{
      const original=fetch;
      globalThis.fetch=async(url,options)=>String(url)==='https://cdna.artstation.com/pc-test.png'?new Response(await (await original(image)).blob()):original(url,options);
    },image);
    const popup=await ctx.newPage();
    await popup.goto(origin+'popup.html');
    const registration=path.join(registry,name+'.json');
    await fs.rename(registration,registration+'.off');
    await popup.click('#codex-connect');
    await popup.waitForFunction(()=>document.querySelector('#status').textContent.includes('登记助手'));
    await fs.rename(registration+'.off',registration);
    for(const [mode,expected] of [['signed-out','未识别'],['exit','中断'],['ok','已连接']]){
      await fs.writeFile(statusFile,mode);
      await popup.locator('#codex-connect').click();
      await popup.waitForFunction(s=>document.querySelector('#status').textContent.includes(s),expected);
      const saved=await worker.evaluate(async()=>(await chrome.storage.local.get('generationMode')).generationMode);
      assert.equal(saved,mode==='ok'?'codex':undefined);
    }
    const settings=await ctx.newPage();await settings.goto(origin+'settings.html');
    await settings.waitForFunction(()=>document.querySelector('#mode').value==='codex');
    await settings.click('#codex-connect');await settings.waitForFunction(()=>document.querySelector('#notice').textContent.includes('已连接'));
    const source='https://www.artstation.com/artwork/pc-test';
    await ctx.route(source,r=>r.fulfill({contentType:'text/html',body:'<body style="padding:80px"><img id="art" width="240" height="360" src="https://cdna.artstation.com/pc-test.png"></body>'}));
    await ctx.route('https://cdna.artstation.com/pc-test.png',r=>r.fulfill({contentType:'image/png',path:fixture}));
    const page=await ctx.newPage();await page.goto(source);await page.locator('#art').hover();
    const overlay=page.locator('print-chamber-overlay');await overlay.locator('.panel.waiting').waitFor();await overlay.hover();
    assert.deepEqual((await fs.readFile(calls,'utf8')).trim().split('\n'),Array(4).fill('connect'));
    await overlay.locator('.retry').click();await overlay.locator('.panel.ready').waitFor();
    const history=await worker.evaluate(async()=>(await chrome.storage.local.get('history')).history);
    assert.equal(history.length,1);assert.equal(history[0].provider,'codex');
    await page.reload();await page.locator('#art').hover();await overlay.locator('.panel.ready').waitFor();
    assert.equal((await fs.readFile(calls,'utf8')).trim().split('\n').filter(x=>x==='generate').length,1);
  }finally{if(ctx)await ctx.close();await fs.rm(dir,{recursive:true,force:true});}
});
