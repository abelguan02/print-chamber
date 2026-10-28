const $=s=>document.querySelector(s);
let saved={configs:{}},working=false;
for(const [id,p] of Object.entries(Cloud.providers))$('#provider').add(new Option(p.name,id));
async function send(message){const r=await chrome.runtime.sendMessage(message);if(!r||r.error)throw Error(r?.error||'设置服务未响应，请重新加载插件');return r;}
function visibility(){const cloud=$('#mode').value==='cloud';$('#cloud-fields').hidden=!cloud;$('#trial-section').hidden=!cloud;$('#local-note').hidden=cloud;}
function providerFields(){
 const id=$('#provider').value,c=saved.configs[id]||{};$('#key').value='';$('#key').placeholder=c.hasKey?'输入新 Key 可替换':'粘贴 API Key';
 $('#provider-notice').textContent=Cloud.providers[id].notice||'';$('#provider-notice').hidden=!Cloud.providers[id].notice;
 $('#key-state').textContent=c.hasKey?'已保存密钥，留空沿用':'';$('#key-state').hidden=!c.hasKey;$('#ali-fields').hidden=id!=='ali';
 $('#cloud-check-help').textContent=id==='google'?'查询所选模型，不生成图片；生成能力需试生成确认。':'仅检查接口可达性，不生成图片；密钥和模型可用性需试生成确认。';
 $('#provider-region-note').hidden=!id.startsWith('minimax');
 $('#region').value=c.region||'cn-beijing';$('#workspace').value=c.workspace||'';
 $('#model').replaceChildren(...Cloud.providers[id].models.map(m=>new Option(m,m)));$('#model').value=c.model||Cloud.providers[id].models[0];
 $('#verification').textContent=c.verifiedAt?'此配置曾生成成功：'+new Date(c.verifiedAt).toLocaleString():'尚未进行真实生成验证';
}
function clearResult(){ $('#preview').hidden=true;$('#preview').removeAttribute('src');$('#download').hidden=true;$('#download').removeAttribute('href');}
async function save(){
 const mode=$('#mode').value;if(mode==='cloud'&&!$('#consent').checked)throw Error('请先确认原图上传和云端计费说明');
 if(mode==='local')await LocalSettings.save();
 saved=await send({type:'cloud-save',config:{mode,provider:$('#provider').value,key:$('#key').value,model:$('#model').value,workspace:$('#workspace').value.trim(),region:$('#region').value}});
 $('#key').value='';$('#first-use-note').hidden=true;providerFields();return saved;
}
async function action(fn){if(working)return;working=true;$('#fields').disabled=true;$('#notice').textContent='正在处理…';try{await fn();}catch(e){$('#notice').textContent=e.message;}finally{working=false;$('#fields').disabled=false;}}
$('#mode').onchange=()=>{$('#first-use-note').hidden=true;$('#notice').textContent='';visibility();clearResult();};
$('#provider').onchange=()=>{providerFields();clearResult();$('#notice').textContent='';};
for(const id of ['key','region','workspace','model'])$('#'+id).addEventListener('input',()=>{$('#verification').textContent='配置已更改，保存后需要重新验证';clearResult();});
$('#settings').onsubmit=e=>{e.preventDefault();action(async()=>{await save();$('#notice').textContent=saved.mode==='cloud'?'已启用云端生成，可能产生费用。':'已保存本地配置。';});};
$('#local-check').onclick=()=>action(async()=>{$('#notice').textContent='';await LocalSettings.check();});
$('#check').onclick=()=>action(async()=>{await save();const r=await send({type:'cloud-check'});$('#notice').textContent=r.message;});
$('#forget').onclick=()=>action(async()=>{saved=await send({type:'cloud-forget',provider:$('#provider').value});$('#mode').value=saved.mode;providerFields();visibility();clearResult();$('#notice').textContent=saved.mode==='local'?'密钥已删除，当前为本地模式。':'密钥已删除。';});
$('#trial').onclick=()=>action(async()=>{
 const file=$('#file').files[0];if(!file||!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>12000000)throw Error('请选择 12 MB 以内的 PNG、JPEG 或 WebP 原画');
 if(!confirm('将上传这张原画并调用所选模型生成 1 张图片，可能产生费用。继续？')){$('#notice').textContent='已取消，没有发起生成请求。';return;}
 const data=await Cloud.prepare(file,1536);await save();clearResult();$('#notice').textContent='正在云端生成，请保留此页；等待超时也可能已计费。';
 const result=await send({type:'cloud-trial',data,confirmed:true});
 $('#preview').src=result.image;await $('#preview').decode();$('#preview').hidden=false;$('#download').href=result.image;$('#download').hidden=false;
 saved=await send({type:'cloud-load'});providerFields();$('#notice').textContent=`实际生成通过 · ${result.seconds.toFixed(1)} 秒。请自行确认肤色、表情、服装和结构是否符合预期。`;
});
Promise.all([send({type:'cloud-load'}),chrome.storage.local.get(['generationMode','token'])]).then(([r,local])=>{
 const firstUse=!local.generationMode&&!local.token&&!Object.values(r.configs).some(c=>c.hasKey);
 saved=r;$('#mode').value=firstUse?'cloud':r.mode;$('#first-use-note').hidden=!firstUse;
 $('#provider').value=r.provider;$('#consent').checked=!firstUse&&r.mode==='cloud';providerFields();visibility();
}).catch(e=>{$('#fields').disabled=true;$('#notice').textContent=e.message;});
