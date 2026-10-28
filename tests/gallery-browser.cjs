const {test}=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const root=path.resolve(__dirname,'..');

test('Gallery printer fits narrow content gutters without distorting its shape or breaking controls',async()=>{
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'chamber-gallery-'));
 let context;
 try{
  context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:require('./browser-options.cjs').executablePath,args:[`--disable-extensions-except=${root}/extension`,`--load-extension=${root}/extension`]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const base='chrome-extension://'+new URL(worker.url()).host;
  const image='data:image/png;base64,'+(await fs.readFile(require('./browser-options.cjs').fixture)).toString('base64');
  const record={id:'responsive',image,sourceUrl:'https://cdna.artstation.com/test.png',pageUrl:'https://www.artstation.com/artwork/test',title:'图库窄屏检查',site:'www.artstation.com',seconds:2.6,createdAt:Date.now()};
  await worker.evaluate(record=>chrome.storage.local.set({history:[record],token:'test'}),record);
  await context.route('http://127.0.0.1:8877/health',r=>r.fulfill({contentType:'application/json',body:'{"ready":true}'}));
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:1440,height:900});await page.goto(base+'/gallery.html');
  await page.locator('#records article').waitFor();await page.evaluate(()=>document.fonts.ready);
  const out=path.join(root,'output/gallery-responsive-20261027');await fs.mkdir(out,{recursive:true});
  for(const width of [1440,320,360,375,387,388,390,768,1440]){
   await page.setViewportSize({width,height:900});
   const layout=await page.locator('#hero-printer').evaluate(hero=>{
    const r=hero.getBoundingClientRect(),m=hero.querySelector('.machine').getBoundingClientRect();
    return {scrollWidth:document.documentElement.scrollWidth,x:r.x,right:r.right,width:r.width,height:r.height,machineWidth:m.width,machineHeight:m.height};
   });
   assert.ok(layout.scrollWidth<=width,`Gallery overflows at ${width}px: ${layout.scrollWidth}px`);
   assert.ok(layout.x>=24-.1&&layout.right<=width-24+.1,`Printer must respect both 24px gutters at ${width}px`);
   const expectedWidth=Math.min(340,width-48);
   assert.ok(Math.abs(layout.width-expectedWidth)<.1,`Printer width at ${width}px: ${layout.width}`);
   assert.ok(Math.abs(layout.height/layout.width-580/340)<.001,'Printer must scale proportionally');
   assert.ok(Math.abs(layout.machineWidth/layout.width-300/340)<.001,'Machine keeps its original width relative to the panel');
   await page.screenshot({path:path.join(out,`gallery-${width}.png`),fullPage:true});
   if(width===320){
    await page.locator('#hero-printer .pin').click();await page.locator('#detail').waitFor();await page.locator('#dismiss').click();
    await page.click('#manage-prints');await page.check('#select-all');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Batch toolbar must also fit');
    await page.click('#manage-prints');
   }
  }
  await worker.evaluate(()=>chrome.storage.local.set({history:[]}));await page.locator('#records .empty').waitFor();
  await page.setViewportSize({width:320,height:900});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Empty gallery must also fit');
  await page.screenshot({path:path.join(out,'empty-320.png'),fullPage:true});
  assert.deepEqual(errors,[]);
 }finally{await context?.close();await fs.rm(profile,{recursive:true,force:true});}
});
