// Read-only UI audit in an isolated headless extension profile. No real model/API requests.
const {chromium}=require('playwright');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..');
const out=path.join(root,'output/visual-audit-20261027');
fs.mkdirSync(out,{recursive:true});
const measurements=[];
const errors=[];
async function capture(page,name){
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:path.join(out,name+'.png'),fullPage:true});
  const metrics=await page.evaluate(()=>{
    const style=e=>{if(!e)return null;const s=getComputedStyle(e),r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,font:s.fontFamily,fontSize:s.fontSize,color:s.color,background:s.backgroundColor,radius:s.borderRadius}};
    const all=[...document.querySelectorAll('*')];
    return {viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,
      overflow:all.filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'&&(r.right>innerWidth+1||r.left< -1)}).slice(0,12).map(e=>({tag:e.tagName,id:e.id,cls:e.className,rect:style(e)})),
      body:style(document.body),main:style(document.querySelector('main,#gallery>div,#dashboard:not([hidden]),#setup:not([hidden])')),h1:style(document.querySelector('h1')),
      fontFaces:[...document.fonts].map(f=>({family:f.family,status:f.status})),
      brokenImages:[...document.images].filter(i=>i.offsetWidth&&i.complete&&!i.naturalWidth).map(i=>i.alt),
      controls:[...document.querySelectorAll('input,select,button')].filter(e=>e.offsetWidth).slice(0,8).map(style)};
  });
  measurements.push({name,...metrics});
}
(async()=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'chamber-visual-audit-'));
  let context;
  try{
    context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:require('../tests/browser-options.cjs').executablePath,args:[`--disable-extensions-except=${root}/extension`,`--load-extension=${root}/extension`]});
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const base='chrome-extension://'+new URL(worker.url()).host;
    const image='data:image/png;base64,'+fs.readFileSync(require('../tests/browser-options.cjs').fixture).toString('base64');
    await context.route('http://127.0.0.1:8877/health',r=>r.fulfill({contentType:'application/json',body:'{"ready":true,"busy":false,"failed":false}'}));
    await context.route('https://**/*',r=>r.abort());
    const history=Array.from({length:8},(_,i)=>({id:String(i),image,sourceUrl:`https://cdna.artstation.com/audit-${i}.png`,pageUrl:'https://www.artstation.com/artwork/fixture',title:i===0?'多层机械结构与复杂材质的原画设计 · 长标题显示检查':'原画视觉检查 '+(i+1),site:i%2?'www.behance.net':'www.artstation.com',seconds:2.6,createdAt:Date.now()}));
    await worker.evaluate(async({history,image})=>{
      await chrome.storage.local.clear();await chrome.storage.local.set({token:'visual-test-only',generationMode:'local',enabled:true,history});
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(CLOUD_PROMPT));
      const promptHash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
      const original=fetch;
      globalThis.fetch=async(url,opts)=>{
        if(url==='http://127.0.0.1:8877/generate')return new Response(JSON.stringify({image,seconds:2.6,cached:false,promptHash}),{headers:{'Content-Type':'application/json'}});
        if(String(url).startsWith('https:'))throw Error('Audit forbids external network');
        return original(url,opts);
      };
    },{history,image});
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.emulateMedia({reducedMotion:'reduce'});
    for(const width of [1440,768,390,320]){
      await page.setViewportSize({width,height:900});
      await page.goto(base+'/gallery.html');await page.locator('#records article').first().waitFor();
      await capture(page,'gallery-'+width);
      if(width===320||width===1440){await page.click('#manage-prints');await page.check('#select-all');await capture(page,'gallery-batch-'+width);await page.click('#manage-prints');await page.locator('.picture').first().click();await capture(page,'gallery-detail-'+width);await page.keyboard.press('Escape');}
      await page.goto(base+'/settings.html');await page.waitForFunction(()=>document.querySelector('#mode').value==='local');
      await capture(page,'settings-local-'+width);
      await page.selectOption('#mode','cloud');await capture(page,'settings-cloud-'+width);
      await page.goto(base+'/about.html');await page.waitForFunction(()=>!document.querySelector('#copy-version').disabled);await capture(page,'about-'+width);
    }
    for(const width of [360,375]){
      await page.setViewportSize({width,height:900});await page.goto(base+'/gallery.html');await page.locator('#records article').first().waitFor();await capture(page,'gallery-'+width);
    }
    await page.setViewportSize({width:360,height:650});await page.goto(base+'/popup.html');await page.locator('#dashboard').waitFor();await capture(page,'popup-dashboard');
    await worker.evaluate(()=>chrome.storage.local.set({token:'',history:[]}));await page.reload();await page.locator('#setup').waitFor();await capture(page,'popup-setup');
    await page.setViewportSize({width:390,height:700});await page.goto(base+'/gallery.html');await page.locator('#records .empty').waitFor();await capture(page,'gallery-empty-390');
    // Use only a controlled page and synthetic artwork for the actual content script.
    await worker.evaluate(()=>chrome.storage.local.set({token:'visual-test-only',history:[],trigger:'hover'}));
    await context.unroute('https://**/*');
    await context.route('https://**/*',r=>r.request().url()==='https://www.artstation.com/visual-audit'?r.fulfill({contentType:'text/html',body:`<body style="margin:0;padding:80px 30px;background:#151515"><img id="art" style="width:200px;height:270px" src="${image}"></body>`}):r.abort());
    await page.goto('https://www.artstation.com/visual-audit');
    for(const width of [1440,390,320]){
      await page.setViewportSize({width,height:700});await page.locator('#art').hover();
      const host=page.locator('print-chamber-overlay');await host.locator('.panel.ready').waitFor();await host.hover();await capture(page,'hover-ready-'+width);
      const box=await host.boundingBox();measurements.push({name:'overlay-box-'+width,box});
      await host.locator('.pin').click();await page.waitForTimeout(100);await capture(page,'tray-'+width);
      await page.keyboard.press('Escape');await page.mouse.move(5,5);await page.waitForTimeout(700);
    }
    await context.route('http://127.0.0.1:8877/demo',r=>r.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'demo.html'),'utf8')}));
    await context.route('http://127.0.0.1:8877/sample/*',r=>r.fulfill({contentType:'image/png',body:fs.readFileSync(require('../tests/browser-options.cjs').fixture)}));
    for(const width of [1440,320]){
      await page.setViewportSize({width,height:900});await page.goto('http://127.0.0.1:8877/demo');await capture(page,'demo-'+width);
    }
    // Capture all five boards of the preserved design using its embedded renderer.
    await page.setViewportSize({width:1900,height:1400});await page.goto(pathToFileURL(path.join(root,'design-reference/original.html')).href);await page.waitForTimeout(1000);
    const boards=page.locator('.board iframe');
    for(let i=0;i<await boards.count();i++)await boards.nth(i).screenshot({path:path.join(out,'reference-'+i+'.png')});
    fs.writeFileSync(path.join(out,'measurements.json'),JSON.stringify({errors,measurements},null,2));
    console.log(JSON.stringify({screenshots:fs.readdirSync(out).filter(f=>f.endsWith('.png')).length,errors,overflow:measurements.filter(m=>m.scrollWidth>m.viewport).map(m=>({name:m.name,viewport:m.viewport,scrollWidth:m.scrollWidth,elements:m.overflow.map(e=>({tag:e.tag,id:e.id,cls:e.cls,width:e.rect.width,x:e.rect.x}))})),out},null,2));
  }finally{await context?.close();fs.rmSync(profile,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
