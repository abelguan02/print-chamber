// Real DOM/canvas regression checks in an isolated headless browser; no model or site access.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

async function scenario(check) {
  const browser = await chromium.launch({headless: true, executablePath: require('./browser-options.cjs').executablePath});
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.route('**/*', r => r.fulfill({contentType:'text/html', body:'<body style="margin:80px"><img id="art" width="240" height="300"></body>'}));
    await page.goto('https://www.artstation.com/regression');
    await page.evaluate(() => {
      window.requests = []; window.historyRecords = []; window.changes = [];
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 300;
      canvas.getContext('2d').fillRect(100,100,40,40);
      window.original = canvas.toDataURL('image/png'); document.querySelector('#art').src = original;
      canvas.getContext('2d').fillStyle = 'red'; canvas.getContext('2d').fillRect(0,0,240,300);
      window.newResult = canvas.toDataURL('image/png');
      window.chrome = {
        runtime: {getURL: p => p, getManifest: () => ({version:'test'}), onMessage: {addListener() {}},
          sendMessage: async message => {
            if(message.type !== 'generate') return {ok:true};
            requests.push(message); const image = requests.length === 1 ? original : newResult;
            const previous = historyRecords;
            historyRecords = [{id:String(requests.length), sourceUrl:message.url, image, seconds:1}];
            changes.forEach(f=>f({history:{oldValue:previous,newValue:historyRecords}}));
            return {image, seconds:1, recordId:String(requests.length)};
          }},
        storage: {local: {get:async()=>({enabled:true})}, onChanged:{addListener:f=>changes.push(f)}}
      };
    });
    await page.addScriptTag({path:path.join(root,'extension/chamber-style.js')});
    await page.addScriptTag({path:path.join(root,'extension/chamber-markup.js')});
    await page.evaluate(()=>{loadChamberFonts=()=>{};});
    await page.addScriptTag({path:path.join(root,'extension/content.js')});
    const host=page.locator('print-chamber-overlay');
    async function print() {
      await page.mouse.move(0,0); await page.locator('#art').hover();
      await host.waitFor({state:'visible'}); await host.hover();
      await host.locator('.panel.ready').waitFor();
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
  const photo=page.locator('print-chamber-tray .tray-photo img');
  assert.ok(await photo.getAttribute('src')===await page.evaluate(()=>newResult),'tray must show latest result');
  await host.locator('.pin').click(); assert.equal(await photo.count(),1,'one pin per source');
  await page.evaluate(()=>changes.forEach(f=>f({history:{oldValue:historyRecords,newValue:[]}})));
  assert.equal(await photo.count(),0);
}));
