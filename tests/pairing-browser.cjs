// Requires menu-helper/build.py --release. Only the fixture HOME is registered.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const {id,origin,name} = require('../native/identity.cjs');
const {version} = require('../extension/manifest.json');
const {executablePath} = require('./browser-options.cjs');

test('moved app pairs with its synchronized extension, refreshes local credentials and offers reload on update',
     {skip:process.platform!=='darwin',timeout:100000}, async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'pc-bundle-pairing-')));
  let ctx;
  t.after(async()=>{await ctx?.close();await fs.rm(home,{recursive:true,force:true});});
  const profile = path.join(home,'Library/Application Support/Google/Chrome');
  const registration = path.join(profile,'NativeMessagingHosts',name+'.json');
  const state = path.join(home,'isolated app state');
  const extension = path.join(state,'extension');
  const initial = path.join(home,'Print Chamber.app');
  const moved = path.join(home,'Other folder','Print Chamber.app');
  function launch(app) {
    const env={HOME:home,PATH:'/usr/bin:/bin',PRINT_CHAMBER_STATE:state};
    return JSON.parse(execFileSync(path.join(app,'Contents/MacOS/PrintChamberHelper'),
      ['--self-test','--test-registration'],{env,timeout:15000,encoding:'utf8'}));
  }
  async function checkRegistration(app) {
    const entry=JSON.parse(await fs.readFile(registration,'utf8'));
    assert.deepEqual(entry.allowed_origins,[origin]);
    assert.equal(entry.path,path.join(app,'Contents/MacOS/print-chamber-host'));
    await fs.access(entry.path,require('node:fs').constants.X_OK);
  }
  execFileSync('ditto',[path.resolve(__dirname,'../dist/Print Chamber.app'),initial]);
  const first=launch(initial);
  assert.equal(first.extensionStatus,'未加载');
  assert.deepEqual(first.settingsRows.map(row=>row[0]),['Chrome 扩展','本地模型','本机 Codex']);
  assert.ok(first.settingsRows[0].includes('未加载'));
  assert.ok(first.settingsRows[1].includes('未安装'));
  await checkRegistration(initial);
  await fs.mkdir(path.dirname(moved));
  await fs.rename(initial,moved);
  launch(moved);
  await checkRegistration(moved);

  // Chrome caches the loaded version until reload. Simulate an app update in place.
  const file=path.join(extension,'manifest.json');
  const manifest=JSON.parse(await fs.readFile(file,'utf8'));
  manifest.version='0.0.1';
  await fs.writeFile(file,JSON.stringify(manifest));
  ctx=await chromium.launchPersistentContext(profile,{headless:true,executablePath,
    env:{...process.env,HOME:home},args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
  const manager=await ctx.newPage();
  await manager.goto('chrome://extensions/');
  await manager.evaluate(()=>chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}));
  const worker=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');
  assert.equal(new URL(worker.url()).host,id);
  // Real packaged host for pairing. This test never probes the installed Codex or requests a turn.
  await worker.evaluate(()=>{
    const nativeRequest=codexRequest;
    globalThis.codexRequest=request=>request.type==='detect'?Promise.resolve({found:false}):nativeRequest(request);
  });
  const gallery=await ctx.newPage();
  await gallery.goto(origin+'gallery.html');
  for(const type of ['pairing-local','pairing-status']){
    const reply=await gallery.evaluate(type=>chrome.runtime.sendMessage({type}),type);
    assert.match(reply.error,/仅扩展配置页面/);
  }
  await gallery.close();
  const popup=await ctx.newPage();
  await popup.goto(origin+'popup.html');
  await popup.locator('#update-extension').waitFor();
  await popup.locator('#token').waitFor();
  const settings=await ctx.newPage();
  await settings.goto(origin+'settings.html');
  await settings.locator('#update-extension').waitFor();
  await settings.selectOption('#mode','local');
  await settings.locator('#local-token').waitFor();
  await settings.click('#local-check');
  await settings.waitForFunction(()=>!document.querySelector('#fields').disabled);
  assert.equal(await settings.locator('#local-status').innerText(),'未配置');
  let expected='fixture-popup';
  await ctx.route('http://127.0.0.1:8877/health',route=>{
    assert.equal(route.request().headers().authorization,'Bearer '+expected);
    return route.fulfill({contentType:'application/json',body:'{"ready":true,"failed":false,"busy":false}'});
  });
  await fs.writeFile(path.join(state,'token'),'fixture-popup');
  await popup.getByRole('button',{name:'测试本地连接'}).click();
  await popup.waitForFunction(()=>document.querySelector('#dashboard-lcd').textContent==='READY');
  await popup.close(); // No dashboard refresh while testing settings' rotated code.
  expected='fixture-rotated';
  await fs.writeFile(path.join(state,'token'),expected);
  await settings.click('#local-check');
  await settings.waitForFunction(()=>document.querySelector('#local-status').textContent==='已就绪');
  assert.equal(await settings.locator('#local-token').isVisible(),false);
  assert.equal((await worker.evaluate(()=>chrome.storage.local.get('token'))).token,'fixture-rotated');
  assert.equal(launch(moved).extensionStatus,'已连接 · v0.0.1');
  await settings.click('#update-extension');
  // A reloaded MV3 worker can stay asleep until an extension page sends a message.
  const fresh=await ctx.newPage();
  await manager.waitForFunction(async ({id,version})=>(await chrome.developerPrivate.getExtensionsInfo({}))
    .some(entry=>entry.id===id && entry.version===version && entry.state==='ENABLED'),{id,version});
  await fresh.goto(origin+'popup.html');
  assert.equal(await fresh.evaluate(()=>Pairing.ready),true);
  assert.equal(await fresh.evaluate(()=>chrome.runtime.getManifest().version),version);
  assert.equal(await fresh.locator('#update-extension').isVisible(),false);
  assert.ok(launch(moved).settingsRows[0].includes('已连接 · v'+version));
});

for (const helperError of [null, '无法读取本地连接码']) {
test('manual pairing in both views when the helper reports '+(helperError || 'no local code'),async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'pc-manual-pairing-'));
  const extension=path.resolve(__dirname,'../extension');
  let ctx;
  t.after(async()=>{await ctx?.close();await fs.rm(home,{recursive:true,force:true});});
  ctx=await chromium.launchPersistentContext(path.join(home,'profile'),{headless:true,executablePath,
    env:{...process.env,HOME:home},args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
  const worker=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');
  await worker.evaluate(()=>{
    globalThis.fixtureCode='fixture-automatic';
    globalThis.codexRequest=async request=>{
      if(request.type==='hello')return {appVersion:'0.3.0',extensionVersion:'0.3.0'};
      if(request.type==='local-token')return {token:globalThis.fixtureCode};
      if(request.type==='detect')return {found:false};
      throw Error('Unexpected native request');
    };
  });
  const checked=[];
  await ctx.route('http://127.0.0.1:8877/health',route=>{
    checked.push(route.request().headers().authorization);
    return route.fulfill({contentType:'application/json',body:'{"ready":true,"failed":false,"busy":false}'});
  });
  const settings=await ctx.newPage();
  await settings.goto(origin+'settings.html');
  await settings.selectOption('#mode','local');
  await settings.locator('#manual-pairing').waitFor({state:'hidden'});
  const popup=await ctx.newPage();
  await popup.goto(origin+'popup.html');
  await popup.locator('#setup').waitFor();
  await popup.locator('#token').waitFor({state:'hidden'});
  assert.deepEqual(await worker.evaluate(()=>chrome.storage.local.get('token')),{});

  await worker.evaluate(error=>{
    globalThis.fixtureCode=null;
    if (error) {
      const previous=globalThis.codexRequest;
      globalThis.codexRequest=request=>request.type==='local-token' ? Promise.resolve({error}) : previous(request);
    }
  },helperError);
  await settings.click('#local-check');
  await settings.locator('#local-token').waitFor();
  if(helperError)await settings.waitForFunction(error=>document.querySelector('#local-status').textContent===error,helperError);
  await settings.locator('#local-token').fill('fixture-settings');
  await settings.click('#local-check');
  await settings.waitForFunction(()=>document.querySelector('#local-status').textContent==='已就绪');
  assert.equal(await settings.locator('#local-token').isVisible(),true);
  assert.deepEqual(checked,['Bearer fixture-settings']);

  const checkPopup=popup.getByRole('button',{name:'测试本地连接'});
  await checkPopup.click();
  await popup.locator('#token').waitFor();
  if(helperError)await popup.waitForFunction(error=>document.querySelector('#status').textContent===error,helperError);
  await popup.locator('#token').fill('fixture-popup-manual');
  await checkPopup.click();
  await popup.waitForFunction(()=>document.querySelector('#dashboard-lcd').textContent==='READY');
  assert.equal(checked.at(-1),'Bearer fixture-popup-manual');
  await popup.close();
  await settings.click('#save-settings');
  await settings.waitForFunction(()=>document.querySelector('#notice').textContent==='已保存');
  assert.equal((await worker.evaluate(()=>chrome.storage.local.get('token'))).token,'fixture-settings');
});
}
