// Explicit, zero-turn smoke test for a registered macOS host and existing login.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {chromium}=require('playwright');
const {id,name,origin}=require('../native/install.cjs');
const {executablePath}=require('./browser-options.cjs');

test('registered Chrome host opens a read-only print session with no model turn',async t=>{
  const ext=path.resolve(__dirname,'../extension');
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'pc-session-live-'));
  let browser;
  try {
    const file=name+'.json';
    const registration=await fs.readFile(path.join(os.homedir(),'Library/Application Support/Google/Chrome/NativeMessagingHosts',file),'utf8');
    assert.deepEqual(JSON.parse(registration).allowed_origins,[origin]);
    const registry=path.join(profile,'NativeMessagingHosts');
    await fs.mkdir(registry);
    await fs.writeFile(path.join(registry,file),registration);
    browser=await chromium.launchPersistentContext(profile,{headless:true,executablePath,args:[
      '--disable-extensions-except='+ext,'--load-extension='+ext,
    ]});
    const worker=browser.serviceWorkers()[0]||await browser.waitForEvent('serviceworker');
    assert.equal(new URL(worker.url()).host,id);
    const reply=await worker.evaluate(host=>new Promise((resolve,reject)=>{
      const port=chrome.runtime.connectNative(host);
      const deadline=setTimeout(()=>{reject(Error('Session check timed out'));port.disconnect();},150000);
      port.onMessage.addListener(message=>{clearTimeout(deadline);resolve(message);port.disconnect();});
      port.onDisconnect.addListener(()=>{
        clearTimeout(deadline);
        reject(Error(chrome.runtime.lastError?.message||'Native host disconnected'));
      });
      port.postMessage({type:'check-session'});
    }),name);
    assert.equal(reply.done?.sessionReady,true,reply.error);
    t.diagnostic('thread/start: '+reply.done.threadStartMs+' ms');
  } finally {
    try {if(browser)await browser.close();} finally {await fs.rm(profile,{recursive:true,force:true});}
  }
});
