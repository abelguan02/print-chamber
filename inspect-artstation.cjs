const {chromium}=require('playwright');
(async()=>{
 const context=await chromium.launchPersistentContext('/private/tmp/print-chamber-artstation-test',{headless:true,executablePath:require('./tests/browser-options.cjs').executablePath,args:[`--disable-extensions-except=${__dirname}/extension`,`--load-extension=${__dirname}/extension`]});
 try {
 const page=await context.newPage();
 await page.goto('https://www.artstation.com/',{waitUntil:'domcontentloaded',timeout:30000});
 await page.waitForTimeout(5000);
 console.log(JSON.stringify(await page.evaluate(()=>({title:document.title,url:location.href,overlay:!!document.querySelector('print-chamber-overlay'),images:[...document.images].filter(i=>i.width>100).slice(0,8).map(i=>({src:i.currentSrc,w:i.width,h:i.height,nw:i.naturalWidth,parents:[i.parentElement?.tagName,i.parentElement?.className,i.parentElement?.parentElement?.className]})),backgrounds:[...document.querySelectorAll('[style]')].filter(e=>e.style.backgroundImage).slice(0,6).map(e=>({tag:e.tagName,cls:e.className,bg:e.style.backgroundImage}))})),null,2));
 await page.screenshot({path:'output/artstation-inspection.png'});
 }finally{await context.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
