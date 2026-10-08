const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/Users/abelguan/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'});
 const page=await browser.newPage({viewport:{width:1900,height:1400}});
 await page.route('https://**/*',r=>r.abort());
 await page.goto('file:///Users/abelguan/Desktop/2Dto3DStyle/design-reference/original.html');
 await page.waitForTimeout(3000);
 for(let i=0;i<5;i++)await page.locator('.board iframe').nth(i).screenshot({path:`output/reference-${i}.png`});
 console.log('Captured all five reference boards.');await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1});
