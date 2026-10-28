const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:require('./tests/browser-options.cjs').executablePath});
 const page=await browser.newPage({viewport:{width:1900,height:1400}});
 await page.route('https://**/*',r=>r.abort());
 await page.goto(require('node:url').pathToFileURL(require('node:path').join(__dirname,'design-reference/original.html')).href);
 await page.waitForTimeout(3000);
 for(let i=0;i<5;i++)await page.locator('.board iframe').nth(i).screenshot({path:`output/reference-${i}.png`});
 console.log('Captured all five reference boards.');await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1});
