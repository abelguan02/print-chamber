const {chromium}=require('playwright');
const fs=require('fs');
const assert=require('node:assert/strict');
(async()=>{
 const context=await chromium.launchPersistentContext('/private/tmp/print-chamber-card-tests',{headless:true,viewport:{width:1400,height:900},executablePath:'/Users/abelguan/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',args:[`--disable-extensions-except=${__dirname}/extension`,`--load-extension=${__dirname}/extension`]});
 try{
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 await worker.evaluate(()=>chrome.storage.local.set({token:'',enabled:true}));
 const page=await context.newPage();
 const image='https://cdna.artstation.com/chamber-fixture.jpg';
 await context.route(image,r=>r.fulfill({contentType:'image/jpeg',body:fs.readFileSync('/Users/abelguan/Downloads/applegreed-web2.jpg')}));
 await context.route('https://www.artstation.com/chamber-fixture',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><style>body{display:flex;gap:80px;padding:40px}.card{width:240px;height:400px;position:relative}img{width:100%;height:100%;object-fit:cover}.overlay{position:absolute;inset:0;background:linear-gradient(transparent,#0003)}.bg{background:center/cover url(${image})}</style><div class="card"><img src="${image}"><div class="overlay"><span>Artwork overlay</span></div></div><div class="card bg"></div><div class="card"><img id="lazy"></div><script>setTimeout(()=>document.querySelector('#lazy').src='${image}',1500)</script>`}));
 await page.goto('https://www.artstation.com/chamber-fixture');
 const host=page.locator('print-chamber-overlay');
 for(const selector of ['.overlay','.bg','#lazy']){
   await page.locator(selector).hover();
   await host.waitFor({state:'visible',timeout:5000});
   await host.locator('.panel.error').waitFor({timeout:5000});
   assert((await host.locator('[role=status]').innerText()).includes('连接码'));
   await page.mouse.move(1380,850); await page.waitForTimeout(850);
   assert(!(await host.isVisible()),`hide after ${selector}`);
 }
 await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({url:'https://www.artstation.com/*'}); await chrome.scripting.executeScript({target:{tabId:tabs[0].id},files:['chamber-markup.js','chamber-style.js','content.js']});});
 assert.equal(await page.locator('print-chamber-overlay').count(),1,'Re-inject without duplicate UI');
 console.log(JSON.stringify({passed:true,tests:['overlay sibling','CSS background','lazy image','delayed hide','reinjection'],environment:'mocked ArtStation URL and fixture; not live site'}));
 }finally{await context.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
