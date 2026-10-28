const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
 const context=await chromium.launchPersistentContext('/private/tmp/print-chamber-stale-test',{headless:true,executablePath:require('./tests/browser-options.cjs').executablePath,args:[`--disable-extensions-except=${__dirname}/extension`,`--load-extension=${__dirname}/extension`]});
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  await worker.evaluate(()=>chrome.storage.local.set({token:'',enabled:true,trigger:'hover',disabledSites:[]}));
  const page=await context.newPage();
  await page.route('https://www.artstation.com/stale-overlay-test',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><print-chamber-overlay id="stale"></print-chamber-overlay><print-chamber-tray id="old-tray"></print-chamber-tray><h1>Reload recovery fixture</h1>'}));
  await page.goto('https://www.artstation.com/stale-overlay-test');
  const status=await worker.evaluate(async()=>{const [tab]=await chrome.tabs.query({url:'https://www.artstation.com/stale-overlay-test'});try{return await chrome.tabs.sendMessage(tab.id,{type:'chamber-ping'})}catch{return {active:false}}});
  assert.equal(status.active,true,'A leftover overlay must not prevent the current content script from starting');
  assert.equal(await page.locator('#stale').count(),0);
  await worker.evaluate(async()=>{const [tab]=await chrome.tabs.query({url:'https://www.artstation.com/stale-overlay-test'});await chrome.scripting.executeScript({target:{tabId:tab.id},files:['chamber-markup.js','chamber-style.js','content.js']})});
  assert.equal(await page.locator('print-chamber-overlay').count(),1);
  assert.equal(await page.locator('print-chamber-tray').count(),1);
  console.log('PASS: stale overlay recovery and duplicate injection protection');
 }finally{await context.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
