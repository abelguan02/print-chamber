// Real DOM/canvas regression checks in an isolated headless browser; no model or site access.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

async function scenario(check, cloud=false) {
  const browser = await chromium.launch({headless: true, executablePath: require('./browser-options.cjs').executablePath});
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.route('**/*', r => r.fulfill({contentType:'text/html', body:'<body style="margin:80px"><img id="art" width="240" height="300"></body>'}));
    await page.goto('https://www.artstation.com/regression');
    await page.evaluate(cloud => {
      window.requests = []; window.historyRecords = []; window.changes = []; window.previews = 0;
      window.failNext = false; window.holdPreview = false;
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 300;
      canvas.getContext('2d').fillRect(100,100,40,40);
      window.original = canvas.toDataURL('image/png'); document.querySelector('#art').src = original;
      canvas.getContext('2d').fillStyle = 'red'; canvas.getContext('2d').fillRect(0,0,240,300);
      window.newResult = canvas.toDataURL('image/png');
      window.canvasReads = 0;
      const encode=HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL=function(...args){canvasReads++;return encode.apply(this,args)};
      window.chrome = {
        runtime: {getURL: p => p, getManifest: () => ({version:'test'}), onMessage: {addListener() {}},
          sendMessage: async message => {
            const saved=historyRecords.find(r=>r.sourceUrl===message.url);
            if(message.type === 'preview') {
              previews++;
              if(holdPreview)await new Promise(resolve=>window.releasePreview=resolve);
              return saved?{...saved,recordId:saved.id,cached:true,fromHistory:true,provider:'local'}:
                {needsGeneration:true,confirmationRequired:cloud};
            }
            if(message.type !== 'generate') return {ok:true};
            if(cloud && message.confirmed!==true)return {needsGeneration:true,confirmationRequired:true};
            requests.push(message); const image = requests.length === 1 ? original : newResult;
            if(failNext){failNext=false;return {error:'模拟生成失败'};}
            const previous = historyRecords;
            historyRecords = [{id:String(requests.length), sourceUrl:message.url, image, seconds:1}];
            changes.forEach(f=>f({history:{oldValue:previous,newValue:historyRecords}}));
            return {image, seconds:1, recordId:String(requests.length)};
          }},
        storage: {local: {get:async()=>({enabled:true})}, onChanged:{addListener:f=>changes.push(f)}}
      };
    },cloud);
    await page.addScriptTag({path:path.join(root,'extension/chamber-style.js')});
    await page.addScriptTag({path:path.join(root,'extension/chamber-markup.js')});
    await page.evaluate(()=>{loadChamberFonts=()=>{};});
    await page.addScriptTag({path:path.join(root,'extension/content.js')});
    const host=page.locator('print-chamber-overlay');
    async function print(state=cloud?'waiting':'ready') {
      await page.mouse.move(0,0); await page.locator('#art').hover();
      await host.waitFor({state:'visible'}); await host.hover();
      await host.locator('.panel.'+state).waitFor({timeout:5000});
    }
    await print(); await check(page, host, print);
  } finally { await browser.close(); }
}

test('canvas upload preserves transparent pixels for server compositing', async()=>scenario(async page=>{
  const pixel=await page.evaluate(async()=>{
    const img=new Image(); img.src=requests[0].data; await img.decode();
    const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
    const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);return [...ctx.getImageData(0,0,1,1).data];
  });
  assert.equal(pixel[3],0,'transparent source must reach the server with alpha intact');
}));

test('reprinting updates a pinned photo, repinning deduplicates, deletion removes it', async()=>scenario(async(page,host,print)=>{
  await host.locator('.pin').click(); await print();
  assert.equal(await page.evaluate(()=>requests.length),1,'viewing a pinned print reuses history');
  await host.locator('.retry').click();await host.locator('.panel.ready').waitFor();
  const photo=page.locator('print-chamber-tray .tray-photo img');
  assert.ok(await photo.getAttribute('src')===await page.evaluate(()=>newResult),'tray must show latest result');
  await host.locator('.pin').click(); assert.equal(await photo.count(),1,'one pin per source');
  await page.evaluate(()=>changes.forEach(f=>f({history:{oldValue:historyRecords,newValue:[]}})));
  assert.equal(await photo.count(),0);
}));

test('cloud hover waits for the existing print button and saved views never upload', async()=>scenario(async(page,host,print)=>{
  assert.equal(await host.locator('.retry').innerText(),'打印');
  assert.match(await host.locator('.caption').innerText(),/上传.*计费/);
  assert.equal(await host.locator('.pin').isDisabled(),true);
  await page.waitForTimeout(800);
  assert.equal(await host.locator('.panel.waiting').count(),1,'loading timer must not start a waiting print');
  assert.deepEqual(await page.evaluate(()=>({requests:requests.length,canvasReads})),{requests:0,canvasReads:0});
  await page.screenshot({path:path.join(root,'output/cloud-confirmation.png')});
  await host.locator('.retry').click();await host.locator('.panel.ready').waitFor();
  const request=await page.evaluate(()=>requests[0]);
  assert.equal(request.confirmed,true);
  assert.equal(request.retry,false,'first cloud print is not a local refresh');
  assert.equal(await host.locator('.retry').innerText(),'重打');
  const reads=await page.evaluate(()=>canvasReads);
  await host.locator('.close').click();await print('ready');
  assert.match(await host.locator('.caption').innerText(),/历史打印/);
  assert.equal(await page.evaluate(()=>requests.length),1);
  assert.equal(await page.evaluate(()=>canvasReads),reads,'history lookup must precede canvas reading');
},true));

test('failed reprint leaves the previous result visible and downloadable', async()=>scenario(async(page,host)=>{
  const previous=await host.locator('.result').getAttribute('src');
  await page.evaluate(()=>{failNext=true});
  await host.locator('.retry').click();
  await page.waitForFunction(()=>document.querySelector('print-chamber-overlay').shadowRoot.querySelector('.caption').textContent.includes('重打失败'));
  assert.equal(await host.locator('.panel.ready').count(),1);
  assert.equal(await host.locator('.result').getAttribute('src'),previous);
  assert.equal(await host.locator('.download').isDisabled(),false);
  assert.equal(await page.evaluate(()=>historyRecords[0].image),previous);
}));

test('a page-script click cannot authorize cloud generation but keyboard input can', async()=>scenario(async(page,host)=>{
  await host.locator('.retry').evaluate(async button=>{button.click();await new Promise(resolve=>setTimeout(resolve,0))});
  assert.equal(await page.evaluate(()=>requests.length),0);
  assert.equal(await page.evaluate(()=>canvasReads),0);
  assert.equal(await host.locator('.panel.waiting').count(),1);
  await host.locator('.retry').focus();await page.keyboard.press('Enter');
  await host.locator('.panel.ready').waitFor();
  assert.equal(await page.evaluate(()=>requests.length),1);
  assert.equal(await page.evaluate(()=>requests[0].confirmed),true);
},true));

test('closing during history lookup prevents a late lookup from starting generation', async()=>scenario(async(page,host)=>{
  await host.locator('.close').click();
  await page.evaluate(()=>{historyRecords=[];holdPreview=true});
  await page.mouse.move(0,0);await page.locator('#art').hover();
  await page.waitForFunction(()=>typeof releasePreview==='function');
  await page.keyboard.press('Escape');await page.evaluate(()=>releasePreview());
  await page.waitForTimeout(100);
  assert.equal(await host.isVisible(),false);
  assert.equal(await page.evaluate(()=>requests.length),1);
}));
