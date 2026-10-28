// Compile the supplied static design into extension-safe HTML. No bundled runtime is shipped.
const fs=require('fs');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:require('./tests/browser-options.cjs').executablePath});
 const page=await browser.newPage();
 async function parse(name,fn){
  const source=fs.readFileSync(`design-reference/${name}.html`,'utf8');
  return page.evaluate(({source,fn})=>{
   const doc=new DOMParser().parseFromString(source,'text/html');
   doc.querySelectorAll('script,helmet').forEach(n=>n.remove());
   // Drop editor-only invalid CSS placeholders before binding real application state.
   doc.querySelectorAll('[style]').forEach(n=>n.setAttribute('style',n.style.cssText));
   return new Function('doc',`return (${fn})(doc)`)(doc);
  },{source,fn:fn.toString()});
 }
 const printer=await parse('printer',doc=>{
  const wrap=doc.querySelector('x-dc>div');wrap.className='printer-wrap';
  [...wrap.querySelectorAll('sc-if')].reverse().forEach(n=>{const d=doc.createElement('div');d.innerHTML=n.innerHTML;d.className=({ '{{showGhost}}':'ghost-wrap','{{showImage}}':'print-sheet-wrap','{{printing}}':'printing-only'})[n.getAttribute('value')];n.replaceWith(d)});
  const ghost=wrap.querySelector('.ghost-wrap>div');ghost.className='ghost';ghost.style.background='';ghost.innerHTML='<img alt="" style="width:100%;height:100%;object-fit:cover">';
  const machine=wrap.children[1];machine.className='machine';
  const buttons=machine.querySelectorAll('button');['close','pin','download','copy','retry'].forEach((c,i)=>buttons[i].className=c);buttons[0].setAttribute('aria-label','关闭预览');
  const viewport=machine.children[1].firstElementChild;viewport.className='viewport';
  const sheet=wrap.querySelector('.print-sheet-wrap>div');sheet.className='print-sheet';sheet.style.background='';sheet.style.clipPath='';sheet.insertAdjacentHTML('afterbegin','<img class="result" alt="原画的 3D 风格预览" style="display:block;width:100%;height:100%;object-fit:contain">');
  const head=viewport.querySelector(':scope>.printing-only');head.classList.add('printhead');
  head.children[0].style.top='0';head.children[1].style.top='-14px';head.children[2].style.top='-18px';
  const console=machine.lastElementChild;console.className='console';const row=console.children[0];row.children[1].className='lcd';row.children[1].textContent='READY';row.children[1].style.color='var(--lcd)';row.children[1].style.textShadow='0 0 8px var(--glow)';
  const led=row.children[2].firstElementChild;led.className='led';led.style.background='var(--led)';led.style.boxShadow='0 0 10px 3px var(--led-glow)';console.children[1].className='keys';console.children[1].style.opacity='';
  const cap=wrap.lastElementChild;cap.className='caption';cap.setAttribute('role','status');cap.setAttribute('aria-live','polite');cap.style.color='';cap.textContent='把鼠标停在原画上开始打印';
  return wrap.outerHTML;
 });
 fs.writeFileSync('extension/chamber-markup.js','// Compiled directly from design-reference/printer.html.\nglobalThis.PRINT_CHAMBER_HTML = '+JSON.stringify(printer)+';\n');
 const popup=await parse('popup',doc=>{
  const board=doc.querySelector('x-dc>div');
  const first=board.children[0].children[1],daily=board.children[1].children[1];
  first.id='setup';daily.id='dashboard';daily.hidden=true;
  const token=first.querySelector('input');token.id='token';token.type='password';first.querySelector('label').htmlFor='token';first.querySelector('button').id='save';first.querySelector('a').id='help';
  first.querySelector('a').href='#help';first.querySelector('a').parentNode.firstChild.textContent='连接码在菜单栏小助手中 · ';first.children[1].firstElementChild.id='setup-lcd';
  daily.children[0].lastElementChild.id='connection-led';daily.children[1].children[0].id='dashboard-lcd';daily.children[1].children[1].id='model-info';
  daily.children[2].children[0].children[1].id='site';daily.children[2].querySelector('button').id='enabled';
  daily.children[3].querySelectorAll('button').forEach((b,i)=>{b.dataset.trigger=i?'alt':'hover';b.setAttribute('aria-pressed',String(!i))});
  daily.children[4].lastElementChild.id='recent';daily.children[4].lastElementChild.innerHTML='';
  daily.querySelector('a').href='gallery.html';daily.querySelector('a').target='_blank';
  return first.outerHTML+daily.outerHTML;
 });
 fs.writeFileSync('extension/popup.html',`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Print Chamber</title><link rel="stylesheet" href="pages.css"><body class="popup">${popup}<p id="status" role="status" hidden></p><div id="help-text" hidden>点击右上角打印机图标 → 启动模型，等待就绪，再点“复制插件连接码”并粘贴到这里。无需打开终端。</div><script src="popup.js"></script></body></html>\n`);
 const gallery=await parse('gallery',doc=>{
  const layout=doc.querySelector('x-dc>div');layout.id='gallery';
  layout.style.minHeight='100vh';
  const container=layout.firstElementChild;container.querySelector('header>div:last-child').id='health';
  const section=container.querySelector('section');section.querySelector('dc-import').outerHTML='<section id="hero-printer" class="panel"></section>';
  const counts=section.querySelector('div>div');counts.children[0].id='total';counts.children[1].id='average';
  const filters=container.children[2];filters.querySelectorAll('button').forEach((b,i)=>{b.dataset.filter=i?b.textContent:'all';b.setAttribute('aria-pressed',String(!i))});
  const grid=container.children[3];grid.id='records';
  const article=grid.querySelector('article');article.style.transform='';article.querySelector('a').textContent='查看原作';
  const card=article.outerHTML.replace(/\{\{[^}]*\}\}/g,'');grid.innerHTML='';return {html:layout.outerHTML,card};
 });
 fs.writeFileSync('extension/gallery.html',`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>打印记录 · Print Chamber</title><link rel="stylesheet" href="pages.css"><body>${gallery.html}<template id="record-template">${gallery.card}</template><dialog id="detail"><button id="dismiss" aria-label="关闭">×</button><img alt="打印结果"><a id="detail-download" download="print-chamber.jpg">下载图片</a></dialog><script src="chamber-markup.js"></script><script src="chamber-style.js"></script><script src="gallery.js"></script></body></html>`);
 await browser.close();console.log('Compiled printer, connection panels and gallery directly from the supplied design.');
})().catch(e=>{console.error(e);process.exitCode=1});
