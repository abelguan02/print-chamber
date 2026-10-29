// IndexedDB belongs to the extension origin; content scripts use the site's origin.
// Keys never enter chrome.storage, history, messages to content scripts, or logs.
globalThis.CloudConfig = (() => {
  function db() {return new Promise((resolve,reject)=>{
    const r=indexedDB.open('print-chamber-private',1);
    r.onupgradeneeded=()=>r.result.createObjectStore('providers');
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('无法打开密钥存储'));
  });}
  async function access(key,value,remove=false) {
    const d=await db();try{return await new Promise((resolve,reject)=>{
      const tx=d.transaction('providers',value!==undefined||remove?'readwrite':'readonly'),s=tx.objectStore('providers');
      const r=remove?s.delete(key):value!==undefined?s.put(value,key):s.get(key);
      tx.oncomplete=()=>resolve(r.result);tx.onerror=tx.onabort=()=>reject(Error('密钥存储失败'));
    });}finally{d.close();}
  }
  async function publicConfig() {
    const {generationMode='local',cloudProvider='volc'}=await chrome.storage.local.get(['generationMode','cloudProvider']);
    const configs={};
    for(const id of Object.keys(Cloud.providers)){
      const c=await access(id);configs[id]=c?{provider:id,model:c.model,region:c.region,workspace:c.workspace,hasKey:!!c.key,verifiedAt:c.verifiedAt||null}:{};
    }
    return {mode:generationMode,provider:cloudProvider,configs};
  }
  async function save(input) {
    if(!['local','cloud'].includes(input.mode))throw Error('生成方式无效');
    if(input.mode==='local'){await chrome.storage.local.set({generationMode:'local'});return publicConfig();}
    if(!Object.hasOwn(Cloud.providers,input.provider))throw Error('供应商无效');
    const old=await access(input.provider)||{};
    const c={provider:input.provider,model:input.model,region:input.region,workspace:input.workspace,key:input.key?.trim()||old.key};
    Cloud.validate(c);
    c.verifiedAt=['model','region','workspace','key'].every(k=>c[k]===old[k])?old.verifiedAt:null;
    await access(c.provider,c);
    await chrome.storage.local.set({generationMode:'cloud',cloudProvider:c.provider,cloudVerified:!!c.verifiedAt});
    return publicConfig();
  }
  async function active() {
    const {cloudProvider}=await chrome.storage.local.get('cloudProvider');
    if(!Object.hasOwn(Cloud.providers,cloudProvider))throw Error('请先在生成设置中选择并保存云端供应商');
    return Cloud.validate(await access(cloudProvider));
  }
  async function verified(c) {c.verifiedAt=Date.now();await access(c.provider,c);await chrome.storage.local.set({cloudVerified:true});}
  async function forget(provider) {
    if(!Object.hasOwn(Cloud.providers,provider))throw Error('供应商无效');
    await access(provider,undefined,true);
    const {cloudProvider}=await chrome.storage.local.get('cloudProvider');
    if(cloudProvider===provider)await chrome.storage.local.set({generationMode:'local',cloudVerified:false});
    return publicConfig();
  }
  return {publicConfig,save,active,verified,forget};
})();
