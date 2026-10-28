const $=s=>document.querySelector(s);
let records=[],filter='all';
let selecting=false,batchBusy=false;
const selected=new Set();
const manage=document.createElement('button');manage.id='manage-prints';manage.className='batch-key';manage.textContent='批量选择';manage.setAttribute('aria-pressed','false');
$('#records').previousElementSibling.lastElementChild.append(manage);
const batch=document.createElement('div');batch.className='batch-toolbar';batch.hidden=true;
batch.innerHTML='<label><input id="select-all" type="checkbox"> 全选当前列表</label><span id="selection-count" role="status"></span><button class="batch-key" id="batch-download">下载 ZIP</button><button class="batch-key danger" id="batch-delete">删除所选</button>';
$('#records').before(batch);
const batchNotice=document.createElement('p');batchNotice.className='batch-notice';batchNotice.setAttribute('role','status');batch.after(batchNotice);
const visibleRecords=()=>records.filter(r=>filter==='all'||siteName(r.site)===filter);
function selectionUI(){
 const visible=visibleRecords();batch.hidden=!selecting;manage.textContent=selecting?'完成选择':'批量选择';manage.setAttribute('aria-pressed',String(selecting));manage.disabled=batchBusy||(!records.length&&!selecting);
 $('#selection-count').textContent=`已选 ${selected.size} 张`;
 $('#select-all').checked=visible.length>0&&visible.every(r=>selected.has(r.id));$('#select-all').indeterminate=selected.size>0&&!$('#select-all').checked;$('#select-all').disabled=batchBusy||!visible.length;
 $('#batch-download').disabled=$('#batch-delete').disabled=batchBusy||!selected.size;
 document.querySelectorAll('[data-filter]').forEach(button=>button.disabled=batchBusy);
 document.querySelectorAll('#records article').forEach(article=>{const checked=selected.has(article.dataset.recordId);article.classList.toggle('selected-print',checked);const input=article.querySelector('.record-select input');input.checked=checked;input.disabled=batchBusy});
 $('#records').classList.toggle('selecting',selecting);
}
function toggleRecord(id){if(batchBusy)return;selected.has(id)?selected.delete(id):selected.add(id);selectionUI()}
manage.onclick=()=>{selecting=!selecting;selected.clear();batchNotice.textContent='';selectionUI()};
$('#select-all').onchange=event=>{selected.clear();if(event.target.checked)visibleRecords().forEach(r=>selected.add(r.id));selectionUI()};
$('#batch-delete').onclick=async()=>{
 const ids=[...selected];if(!ids.length||batchBusy)return;batchBusy=true;selectionUI();
 try{const result=await chrome.runtime.sendMessage({type:'delete-history-batch',ids});if(!result?.ok)throw new Error(result?.error||'删除失败，请重试');selected.clear();batchNotice.textContent=`已删除 ${result.count} 张打印图片`}
 catch(error){batchNotice.textContent=error.message}finally{batchBusy=false;selectionUI()}
};
$('#batch-download').onclick=async()=>{
 const chosen=records.filter(r=>selected.has(r.id));if(!chosen.length||batchBusy)return;batchBusy=true;selectionUI();
 try{
  const {printArchive}=await import('./archive.js');const url=URL.createObjectURL(printArchive(chosen));
  const link=document.createElement('a');link.href=url;link.download='print-chamber.zip';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  batchNotice.textContent=`已打包 ${chosen.length} 张图片`;
 }catch(error){batchNotice.textContent=error.message}finally{batchBusy=false;selectionUI()}
};
const hero=$('#hero-printer');hero.innerHTML=PRINT_CHAMBER_HTML;
const style=document.createElement('style');style.textContent=PRINT_CHAMBER_CSS.replace(/:host[^}]+}/g,'');document.head.append(style);
function detail(record){$('#detail img').src=record.image;$('#detail-download').href=record.image;$('#detail').showModal()}
$('#dismiss').onclick=()=>$('#detail').close();$('#detail').onclick=e=>{if(e.target===$('#detail'))$('#detail').close()};
function render(){
 const visibleIds=new Set(visibleRecords().map(r=>r.id));for(const id of selected)if(!visibleIds.has(id))selected.delete(id);
 $('#total').textContent=records.length+' PRINTS';$('#average').textContent='AVG '+(records.length?(records.reduce((s,r)=>s+Number(r.seconds||0),0)/records.length).toFixed(1)+'S':'—');
 const latest=records[0];hero.className='panel '+(latest?'ready':'');hero.querySelector('.lcd').textContent=latest?'DONE':'READY';
 hero.querySelector('.caption').textContent=latest?(latest.provider&&latest.provider!=='local'?'云端打印':'本地打印')+' · '+Number(latest.seconds||0).toFixed(1)+' 秒 · '+siteName(latest.site):'把鼠标停在原画上开始打印';
 if(latest)hero.querySelector('.result').src=latest.image;
 for(const b of hero.querySelectorAll('.keys button'))b.disabled=!latest;
 hero.querySelector('.pin').onclick=()=>latest&&detail(latest);
 hero.querySelector('.download').onclick=()=>{const a=document.createElement('a');a.href=latest.image;a.download='print-chamber.jpg';a.click()};
 hero.querySelector('.copy').onclick=async()=>{const b=hero.querySelector('.copy');try{const img=hero.querySelector('.result'),c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;c.getContext('2d').drawImage(img,0,0);const blob=await new Promise(r=>c.toBlob(r,'image/png'));await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);b.textContent='已复制'}catch{b.textContent='请下载'}setTimeout(()=>b.textContent='复制',1800)};
 hero.querySelector('.retry').onclick=()=>latest&&chrome.tabs.create({url:latest.pageUrl});hero.querySelector('.retry').title='回到原作页面重新打印';
 hero.querySelector('.close').onclick=()=>{hero.style.visibility='hidden'};
 $('#records').replaceChildren();
 records.filter(r=>filter==='all'||siteName(r.site)===filter).forEach((record,i)=>{
  const fragment=$('#record-template').content.cloneNode(true),article=fragment.querySelector('article');article.style.transform=`rotate(${[-1,.8,-.5,1.2,.6,-1.1,.4,-.7][i%8]}deg)`;
  article.style.position='relative';
  article.dataset.recordId=record.id;
  const remove=document.createElement('button');remove.className='delete-record';remove.textContent='×';remove.title='删除这张打印图片';remove.setAttribute('aria-label','删除这张打印图片');
  remove.onclick=async()=>{
    remove.disabled=true;
    try{const result=await chrome.runtime.sendMessage({type:'delete-history',sourceUrl:record.sourceUrl});if(!result?.ok)throw new Error(result?.error||'删除失败，请重试')}
    catch(error){remove.disabled=false;remove.title=error.message;let notice=article.querySelector('[role=status]');if(!notice){notice=document.createElement('p');notice.setAttribute('role','status');article.append(notice)}notice.textContent=error.message}
  };
  const picture=article.firstElementChild.firstElementChild;picture.style.background='#1E1B16';picture.className='picture';picture.setAttribute('role','button');picture.setAttribute('aria-label','放大打印结果');picture.tabIndex=0;
  const img=document.createElement('img');img.src=record.image;img.alt=record.title;img.loading='lazy';picture.prepend(img);const activate=()=>selecting?toggleRecord(record.id):detail(record);picture.onclick=activate;picture.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();activate()}};
  const a=article.querySelector('a');a.href=record.pageUrl;a.target='_blank';a.rel='noopener noreferrer';a.title=record.title;a.textContent=record.title||'查看原作';
  a.nextElementSibling.textContent=siteName(record.site);article.lastElementChild.children[0].textContent='JOB #'+String(records.length-records.indexOf(record)).padStart(4,'0');article.lastElementChild.children[1].textContent=Number(record.seconds||0).toFixed(1)+'S';article.append(remove);
  const label=document.createElement('label');label.className='record-select';const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.setAttribute('aria-label','选择 '+(record.title||'打印图片'));checkbox.onchange=()=>toggleRecord(record.id);label.append(checkbox);article.append(label);$('#records').append(fragment);
 });
 if(!$('#records').childElementCount){const p=document.createElement('p');p.className='empty';p.textContent=records.length?'这个网站还没有打印记录':'出纸托盘还是空的，去作品页打印第一张吧。';$('#records').append(p)}
 selectionUI();
}
function siteName(host){return /artstation\.com$/.test(host)?'ArtStation':/behance\.net$/.test(host)?'Behance':/pinterest\.com$/.test(host)?'Pinterest':host==='127.0.0.1'?'本地画廊':host}
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;selected.clear();batchNotice.textContent='';document.querySelectorAll('[data-filter]').forEach(n=>n.setAttribute('aria-pressed',String(n===b)));render()});
chrome.storage.local.get(['history','token','generationMode','cloudVerified']).then(async v=>{
 records=v.history||[];render();const id=decodeURIComponent(location.hash.slice(1));const record=records.find(r=>r.id===id);if(record)detail(record);
 let label='OFFLINE',color='#FF5A48';if(v.generationMode==='cloud'){label=v.cloudVerified?'CLOUD':'UNVERIFIED';color=v.cloudVerified?'#7BE07B':'#F4B53A'}else{try{const r=await fetch('http://127.0.0.1:8877/health',{headers:v.token?{Authorization:'Bearer '+v.token}:{},signal:AbortSignal.timeout(2000)});const h=await r.json();if(r.ok&&v.token&&!h.failed){label=h.ready?(h.busy?'PRINTING':'READY'):'LOADING';color=h.ready&&!h.busy?'#7BE07B':'#F4B53A'}}catch{}}
 $('#health').lastElementChild.textContent=label;$('#health').lastElementChild.style.color=color;$('#health').firstElementChild.style.background=color;$('#health').firstElementChild.style.boxShadow='0 0 8px 2px '+color+'88';
});
chrome.storage.onChanged.addListener(c=>{if(c.history){records=c.history.newValue||[];if($('#detail').open)$('#detail').close();render()}});
