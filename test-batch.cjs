const {chromium}=require('playwright');
const fs=require('fs');const assert=require('node:assert/strict');
(async()=>{
 const profile=fs.mkdtempSync('/private/tmp/print-chamber-batch-');
 const context=await chromium.launchPersistentContext(profile,{headless:true,viewport:{width:1440,height:1000},executablePath:require('./tests/browser-options.cjs').executablePath,args:[`--disable-extensions-except=${__dirname}/extension`,`--load-extension=${__dirname}/extension`]});
 try{
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),id=new URL(worker.url()).host;
 const image='data:image/png;base64,'+fs.readFileSync(require('./tests/browser-options.cjs').fixture).toString('base64');
 const records=['a','b','c'].map((id,i)=>({id,image,sourceUrl:`https://example.com/${id}.jpg`,pageUrl:'https://www.artstation.com/',title:`Print ${id}`,site:i===2?'www.behance.net':'www.artstation.com',seconds:2.5,createdAt:Date.now()}));
 await worker.evaluate(history=>chrome.storage.local.set({history}),records);
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`chrome-extension://${id}/gallery.html`);await page.locator('#records article').nth(2).waitFor();
 await page.locator('#manage-prints').click();assert(await page.locator('#batch-delete').isDisabled());
 await page.locator('.picture').first().click();assert.equal(await page.locator('#selection-count').innerText(),'已选 1 张');assert(!await page.locator('#detail').isVisible());
 assert(await page.locator('#select-all').evaluate(el=>el.indeterminate));
 await page.locator('#select-all').check();assert.equal(await page.locator('#selection-count').innerText(),'已选 3 张');
 await page.locator('[data-filter=ArtStation]').click();assert.equal(await page.locator('#selection-count').innerText(),'已选 0 张');
 await page.locator('#select-all').check();assert.equal(await page.locator('#selection-count').innerText(),'已选 2 张');
 await page.screenshot({path:'output/batch-selection.png',fullPage:true});
 const downloading=page.waitForEvent('download',{timeout:10000});await page.locator('#batch-download').click();const download=await downloading;assert.equal(download.suggestedFilename(),'print-chamber.zip');await download.saveAs('output/batch-download-test.zip');
 await page.locator('#batch-delete').click();await page.locator('#records .empty').waitFor();assert.deepEqual(await worker.evaluate(async()=>(await chrome.storage.local.get('history')).history.map(r=>r.id)),['c'],'Filtered select-all must not delete other sites');
 await page.locator('[data-filter=all]').click();await page.locator('#select-all').check();
 await worker.evaluate(record=>chrome.storage.local.get('history').then(({history})=>chrome.storage.local.set({history:[record,...history]})),{...records[0],id:'new',sourceUrl:'https://example.com/new.jpg'});
 await page.locator('#records article').nth(1).waitFor();assert.equal(await page.locator('#selection-count').innerText(),'已选 1 张','New prints must not become selected automatically');
 await page.locator('#batch-delete').click();await page.waitForFunction(()=>document.querySelectorAll('#records article').length===1);assert.deepEqual(await worker.evaluate(async()=>(await chrome.storage.local.get('history')).history.map(r=>r.id)),['new']);
 await page.reload();await page.locator('#records article').waitFor();assert.equal(await page.locator('#records article').count(),1);
 await page.locator('#manage-prints').click();await page.locator('#select-all').check();await page.locator('#select-all').uncheck();assert(await page.locator('#batch-download').isDisabled());
 await page.locator('#select-all').check();await page.locator('#batch-delete').click();await page.locator('#records .empty').waitFor();await page.locator('#manage-prints').click();assert(!await page.locator('.batch-toolbar').isVisible());
 assert.deepEqual(errors,[]);
 const summary={passed:true,tests:['multiple selection','picture selection without opening detail','select-all and deselect','filter-scoped selection','ZIP download','atomic batch deletion','new arrivals remain unselected','persistent deletion','exit selection after deleting all','no JavaScript errors']};fs.writeFileSync('output/batch-test.json',JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
 }finally{await context.close();fs.rmSync(profile,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
