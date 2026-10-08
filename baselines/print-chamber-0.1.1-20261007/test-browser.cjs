const {chromium} = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
(async () => {
  const extension = path.join(__dirname, 'extension');
  const context = await chromium.launchPersistentContext('/private/tmp/print-chamber-browser-test', {
    headless: true, executablePath: '/Users/abelguan/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', viewport: {width:1440,height:1000},
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(token => chrome.storage.local.set({token,enabled:true}),fs.readFileSync('.local/token','utf8').trim());
    const page = await context.newPage(); const errors=[];
    page.on('pageerror', e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:8877/demo');
    const image=page.locator('img[src="/sample/0"]');
    const started = Date.now();
    await image.hover();
    const panel=page.locator('print-chamber-overlay');
    await panel.waitFor({state:'visible'});
    await panel.locator('.pin').click();
    await page.screenshot({path:'output/chamber-waiting.png'});
    await panel.locator('.panel.ready').waitFor({timeout:60000});
    const timing=await panel.locator('.timing').innerText();
    const endToEnd=Number(await panel.locator('.panel').getAttribute('data-total-ms'));
    await page.screenshot({path:'output/chamber-ready.png'});
    await page.mouse.move(10,10); await page.waitForTimeout(800);
    assert(await panel.isVisible(),'Pinned panel must remain visible');
    await panel.locator('.pin').click();
    await page.mouse.move(10,10); await page.waitForTimeout(850);
    assert(!(await panel.isVisible()),'Unpinned panel must close after leaving');
    await image.hover(); await panel.waitFor({state:'visible'});
    await panel.hover(); await page.waitForTimeout(800);
    assert(await panel.isVisible(),'Crossing to panel must keep it open');
    await page.keyboard.press('Escape');
    await worker.evaluate(()=>chrome.storage.local.set({token:'wrong-token'}));
    await page.mouse.move(0,0);
    const second=page.locator('img[src="/sample/2"]');
    await second.hover();
    await panel.locator('.panel.error').waitFor({timeout:10000});
    assert((await panel.locator('[role=status]').innerText()).includes('连接码'));
    await panel.locator('.close').click();
    await worker.evaluate(token=>chrome.storage.local.set({token}),fs.readFileSync('.local/token','utf8').trim());
    assert(!(await panel.isVisible()),'Escape closes panel');
    await page.setViewportSize({width:390,height:844}); await image.hover();
    await panel.waitFor({state:'visible'});
    const box=await panel.boundingBox();
    assert(box.x>=0&&box.x+box.width<=390,'Panel fits small viewport');
    await page.screenshot({path:'output/chamber-narrow.png'});
    await page.keyboard.press('Escape');
    await worker.evaluate(()=>chrome.storage.local.set({enabled:false}));
    await page.mouse.move(0,0); await image.hover(); await page.waitForTimeout(450);
    assert(!(await panel.isVisible()),'Disabled extension must not open');
    assert.deepEqual(errors,[]);
    const summary={passed:true,display_time:timing,hover_to_reveal_complete_ms:endToEnd,tests:['local service result','pin','delayed close','pointer crossing','escape','390px viewport','auth error','disable'],note:'Service cache may be warm; not an uncached inference benchmark.',errors};
    fs.writeFileSync('output/browser-test.json',JSON.stringify(summary,null,2));
    console.log(JSON.stringify(summary));
  } finally {await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
