'use strict';
// Reuse the popup's token storage and fixed loopback service. Never log credentials.
globalThis.LocalSettings = (() => {
 const input=document.querySelector('#local-token');
 const status=document.querySelector('#local-status');
 let storedToken='';
 const localToken=Pairing.bindManualEntry(document.querySelector('#manual-pairing'));
 function reset(){status.textContent=input.value.trim()||storedToken?'尚未检查':'未配置';}
 function describe(){const keyState=document.querySelector('#local-key-state');keyState.textContent=storedToken?'已保存连接码':'';keyState.hidden=!storedToken;input.placeholder=storedToken?'输入新连接码可替换':'粘贴小助手中的连接码';}
 const loaded=chrome.storage.local.get('token').then(({token})=>{storedToken=typeof token==='string'?token:'';describe();reset();});
 input.addEventListener('input',reset);
 chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.token){storedToken=changes.token.newValue||'';describe();reset();}});
 function candidate(){const token=input.value.trim()||storedToken;if(token.length>1024||/[\r\n]/.test(token))throw Error('连接码格式无效');return token;}
 async function save(){await loaded;if(await localToken())return true;const token=candidate();if(token)await chrome.storage.local.set({token});storedToken=token;input.value='';describe();reset();return !!token;}
 async function check(){
  await loaded;
  let token;
  try {token=await localToken() || candidate();}
  catch(error){status.textContent=error.message;return;}
  if(!token){reset();return;}
  status.textContent='检查中…';
  const signal=AbortSignal.timeout(4000);
  try{
   const response=await fetch('http://127.0.0.1:8877/health',{headers:{Authorization:'Bearer '+token},credentials:'omit',redirect:'error',signal});
   if(response.status===401||response.status===403){status.textContent='连接码不匹配';return;}
   if(!response.ok){status.textContent='服务异常 · HTTP '+response.status;return;}
   const health=await response.json();
   if(!health||typeof health.ready!=='boolean'||typeof health.failed!=='boolean'||typeof health.busy!=='boolean'){status.textContent='不是兼容的本地服务';return;}
   status.textContent=health.failed?'模型加载失败 · 查看小助手日志':!health.ready?'模型加载中':health.busy?'模型忙碌':'已就绪';
  }catch(error){
   if(signal.aborted||error.name==='TimeoutError')status.textContent='连接超时';
   else if(error instanceof SyntaxError)status.textContent='不是兼容的本地服务';
   else status.textContent='服务未启动 · 在小助手中启动';
  }
 }
 return {save,check};
})();
