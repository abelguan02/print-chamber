'use strict';
// Reuse the popup's token storage and fixed loopback service. Never log credentials.
globalThis.LocalSettings = (() => {
 const input=document.querySelector('#local-token');
 const status=document.querySelector('#local-status');
 let storedToken='';
 function reset(){status.textContent=input.value.trim()||storedToken?'尚未检查连接':'未配置 · 请粘贴本机连接码';}
 function describe(){const keyState=document.querySelector('#local-key-state');keyState.textContent=storedToken?'已保存连接码，留空沿用':'';keyState.hidden=!storedToken;input.placeholder=storedToken?'输入新连接码可替换':'粘贴小助手中的连接码';}
 const loaded=chrome.storage.local.get('token').then(({token})=>{storedToken=typeof token==='string'?token:'';describe();reset();});
 input.addEventListener('input',reset);
 chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.token){storedToken=changes.token.newValue||'';describe();reset();}});
 function candidate(){const token=input.value.trim()||storedToken;if(token.length>1024||/[\r\n]/.test(token))throw Error('连接码格式无效，请重新复制');return token;}
 async function save(){await loaded;const token=candidate();if(token)await chrome.storage.local.set({token});storedToken=token;input.value='';describe();reset();return !!token;}
 async function check(){
  await loaded;
  const token=candidate();
  if(!token){reset();return;}
  status.textContent='正在检查 · 连接本机服务…';
  try{
   const response=await fetch('http://127.0.0.1:8877/health',{headers:{Authorization:'Bearer '+token},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(4000)});
   if(response.status===401||response.status===403){status.textContent='连接码不匹配 · 请在小助手中重新复制本机连接码';return;}
   if(!response.ok){status.textContent='服务异常 · 本机服务返回 HTTP '+response.status;return;}
   let health;try{health=await response.json();}catch{status.textContent='响应异常 · 本机服务没有返回有效状态';return;}
   if(!health||typeof health.ready!=='boolean'||typeof health.failed!=='boolean'||typeof health.busy!=='boolean'){status.textContent='响应异常 · 无法确认是否为兼容的 Print Chamber 本地服务';return;}
   status.textContent=health.failed?'模型加载失败 · 请在小助手中查看运行日志':!health.ready?'模型加载中 · 稍后再次测试':health.busy?'模型忙碌 · 请等待当前任务完成':'已就绪 · 尚未试生成';
  }catch(error){status.textContent=error.name==='TimeoutError'?'连接超时 · 本机服务未在 4 秒内响应，请检查小助手状态':'无法连接本机服务 · 服务可能尚未启动，请从小助手启动后重试';}
 }
 return {save,check};
})();
