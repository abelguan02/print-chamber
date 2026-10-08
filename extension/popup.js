const $=s=>document.querySelector(s);
let activeTab, currentHost='', supported=false;
const setup=$('#setup'),dashboard=$('#dashboard'),status=$('#status');
function note(text=''){status.textContent=text;status.hidden=!text}
function setView(connected){setup.hidden=connected;dashboard.hidden=!connected}
async function load(){
 const saved=await chrome.storage.local.get(['token','enabled','disabledSites','trigger','history']);
 $('#token').value=saved.token||'';setView(Boolean(saved.token));
 [activeTab]=await chrome.tabs.query({active:true,currentWindow:true});
 try{currentHost=new URL(activeTab?.url).hostname}catch{}
 supported=/^https:\/\/([^/]+\.)?(artstation\.com|behance\.net|pinterest\.com)\//.test(activeTab?.url||'')||(activeTab?.url||'').startsWith('http://127.0.0.1:8877/');
 $('#site').textContent=currentHost||'请打开作品页';$('#enabled').disabled=!supported;
 $('#enabled').setAttribute('aria-pressed',String(supported&&saved.enabled!==false&&!(saved.disabledSites||[]).includes(currentHost)));
 document.querySelectorAll('[data-trigger]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.trigger===(saved.trigger||'hover'))));
 const history=saved.history||[];$('#recent').replaceChildren();
 for(const record of history.slice(0,4)){const link=document.createElement('a');link.href='gallery.html#'+encodeURIComponent(record.id);link.target='_blank';link.title=record.title;const img=document.createElement('img');img.src=record.image;img.alt='查看打印记录';link.append(img);$('#recent').append(link)}
 if(!history.length){const p=document.createElement('span');p.className='empty';p.textContent='打印过的作品会出现在这里';$('#recent').append(p)}
 const today=history.filter(r=>new Date(r.createdAt).toDateString()===new Date().toDateString()).length;
 await check(saved.token,today);
 if(supported&&saved.token)await activate(false);
}
async function check(token,today=0){
 let label='OFFLINE',detail='MODEL OFF',color='#FF5A48';
 try{
  const response=await fetch('http://127.0.0.1:8877/health',{headers:token?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(2000)});
  const health=await response.json();
  if(!response.ok){setView(false);note(response.status===401?'连接码不匹配：请在菜单栏小助手中重新复制连接码并粘贴':(health.error||'连接码无效'));return false}
  if(!token)return false;
  if(health.failed){note('模型加载失败，请在菜单栏小助手中查看运行日志')}
  else if(health.ready){label=health.busy?'PRINTING':'READY';detail=health.busy?'MODEL BUSY':'MODEL OK';color=health.busy?'#F4B53A':'#7BE07B';note()}
  else {label='LOADING';detail='MODEL WAIT';color='#F4B53A';note('模型正在准备，稍后重新打开插件查看')}
  setView(true);
 }catch{note('请点击菜单栏打印机图标 → 启动模型，等待“模型已就绪”')}
 $('#dashboard-lcd').textContent=label;$('#dashboard-lcd').style.color=color;$('#dashboard-lcd').style.textShadow='0 0 8px '+color+'88';
 $('#model-info').replaceChildren(document.createTextNode(detail),document.createElement('br'),document.createTextNode(today+' TODAY'));
 const led=$('#connection-led').firstElementChild;led.style.background=color;led.style.boxShadow='0 0 8px 2px '+color+'88';
 return label!=='OFFLINE';
}
$('#save').onclick=async()=>{
 const token=$('#token').value.trim();if(!token){note('请在菜单栏小助手中复制插件连接码，再粘贴到这里');return}
 $('#save').disabled=true;$('#setup-lcd').textContent='CONNECTING';note();
 try{if(await check(token)){await chrome.storage.local.set({token});await load()}}
 finally{$('#save').disabled=false;$('#setup-lcd').textContent='INSERT KEY'}
};
$('#token').addEventListener('keydown',e=>{if(e.key==='Enter')$('#save').click()});
$('#help').onclick=e=>{e.preventDefault();$('#help-text').hidden=!$('#help-text').hidden};
$('#connection-led').title='点击更换本地连接码';$('#connection-led').role='button';$('#connection-led').tabIndex=0;
$('#connection-led').onclick=()=>{setView(false);$('#token').focus()};$('#connection-led').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('#connection-led').click()}};
async function activate(force){
 if(!supported)return;
 try{
  if(!force){try{const live=await chrome.tabs.sendMessage(activeTab.id,{type:'chamber-ping'});if(live?.active&&live.version===chrome.runtime.getManifest().version)return}catch{}}
  await chrome.scripting.executeScript({target:{tabId:activeTab.id},files:['chamber-markup.js','chamber-style.js','content.js']});
  const live=await chrome.tabs.sendMessage(activeTab.id,{type:'chamber-ping'});
  if(!live?.active)throw new Error('Content script did not start');
 }catch{note('当前页尚未启用，请刷新作品页后再试')}
}
$('#enabled').onclick=async()=>{
 const on=$('#enabled').getAttribute('aria-pressed')!=='true';const {disabledSites=[]}=await chrome.storage.local.get('disabledSites');
 const next=disabledSites.filter(s=>s!==currentHost);if(!on)next.push(currentHost);
 await chrome.storage.local.set({disabledSites:next,enabled:true});$('#enabled').setAttribute('aria-pressed',String(on));if(on)await activate(true);
};
document.querySelectorAll('[data-trigger]').forEach(button=>button.onclick=async()=>{await chrome.storage.local.set({trigger:button.dataset.trigger});document.querySelectorAll('[data-trigger]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)))});
load().catch(()=>note('面板加载失败，请重新打开插件'));
chrome.storage.onChanged.addListener(c=>{if(c.history)load().catch(()=>note('打印记录更新失败，请重新打开插件'))});
