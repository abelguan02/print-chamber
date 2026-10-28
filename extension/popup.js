const $=s=>document.querySelector(s);
let activeTab, currentHost='', supported=false;
let cloudMode=false,cloudVerified=false;
const settingsLink=document.createElement('a');settingsLink.href='settings.html';settingsLink.target='_blank';settingsLink.textContent='生成设置';settingsLink.style.cssText='display:block;text-align:center;margin:12px;font-size:12px;color:#766B5A';document.body.append(settingsLink);
const aboutLink=document.createElement('a');aboutLink.href='about.html';aboutLink.target='_blank';aboutLink.textContent='关于 Print Chamber';aboutLink.style.cssText='display:block;text-align:center;margin:12px;font-size:11px;color:#766B5A';document.body.append(aboutLink);
const setup=$('#setup'),dashboard=$('#dashboard'),status=$('#status');
// Keep the existing panel shell; all configuration now lives in settings.html.
$('#token').parentElement.hidden=true;$('#help').parentElement.hidden=true;
$('#setup-lcd').textContent='SETUP';$('#save').textContent='打开生成设置';
function note(text=''){status.textContent=text;status.hidden=!text}
function setView(connected){setup.hidden=connected;dashboard.hidden=!connected;settingsLink.hidden=!connected}
async function load(){
 const saved=await chrome.storage.local.get(['token','enabled','disabledSites','trigger','history','generationMode','cloudVerified']);
 cloudMode=saved.generationMode==='cloud';cloudVerified=!!saved.cloudVerified;
 setView(cloudMode||Boolean(saved.token));
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
 if(cloudMode||saved.token)await check(saved.token,today);else note();
 if(supported&&(cloudMode||saved.token))await activate(false);
}
async function check(token,today=0){
 let label='OFFLINE',detail='MODEL OFF',color='#FF5A48';
 if(cloudMode){
  label='CLOUD';detail=cloudVerified?'API TESTED':'UNVERIFIED';color=cloudVerified?'#7BE07B':'#F4B53A';setView(true);note(cloudVerified?'云端模式 · 此配置曾生成成功，当前连通性未检查':'云端模式 · 尚未真实生成验证，请打开生成设置');
 }else{
 try{
  const response=await fetch('http://127.0.0.1:8877/health',{headers:token?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(2000)});
  const health=await response.json();
  if(!response.ok){setView(false);note(response.status===401?'连接码不匹配，请在生成设置中更新':(health.error||'连接码无效'));return false}
  if(!token)return false;
  if(health.failed){note('模型加载失败，请在菜单栏小助手中查看运行日志')}
  else if(health.ready){label=health.busy?'PRINTING':'READY';detail=health.busy?'MODEL BUSY':'MODEL OK';color=health.busy?'#F4B53A':'#7BE07B';note()}
  else {label='LOADING';detail='MODEL WAIT';color='#F4B53A';note('模型正在准备，稍后重新打开插件查看')}
  setView(true);
 }catch{note('请点击菜单栏打印机图标 → 启动模型，等待“模型已就绪”')}
 }
 $('#dashboard-lcd').textContent=label;$('#dashboard-lcd').style.color=color;$('#dashboard-lcd').style.textShadow='0 0 8px '+color+'88';
 $('#model-info').replaceChildren(document.createTextNode(detail),document.createElement('br'),document.createTextNode(today+' TODAY'));
 const led=$('#connection-led').firstElementChild;led.style.background=color;led.style.boxShadow='0 0 8px 2px '+color+'88';
 return label!=='OFFLINE';
}
function openSettings(){chrome.runtime.openOptionsPage().catch(()=>note('无法打开生成设置，请重新打开插件'));}
$('#save').onclick=openSettings;
$('#connection-led').title='打开生成设置';$('#connection-led').role='button';$('#connection-led').tabIndex=0;
$('#connection-led').onclick=openSettings;$('#connection-led').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openSettings()}};
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
chrome.storage.onChanged.addListener(c=>{if(c.history||c.generationMode||c.cloudVerified||c.token)load().catch(()=>note('面板更新失败，请重新打开插件'))});
