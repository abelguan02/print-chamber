importScripts('cloud.js', 'cloud-config.js', 'cloud-prompt.js', 'codex.js');
const ENDPOINT = 'http://127.0.0.1:8877';
let busy = false;
let activeJob = null;
// Serialize history writes; deletion also invalidates a matching in-flight job.
let historyWrites=Promise.resolve();
function updateHistory(change){
  const task=historyWrites.then(async()=>{
    const {history=[]}=await chrome.storage.local.get('history');
    const next=change(history);
    await chrome.storage.local.set({history:next});
  });
  historyWrites=task.catch(()=>{});return task;
}
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({url: ['https://*.artstation.com/*', 'https://*.behance.net/*', 'https://*.pinterest.com/*', 'http://127.0.0.1:8877/*']});
  await Promise.allSettled(tabs.map(tab => chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['chamber-markup.js', 'chamber-style.js', 'content.js']})));
});

async function generate(message, tab) {
  const {token, enabled = true, disabledSites = [], generationMode='local', history=[]} = await chrome.storage.local.get(['token', 'enabled', 'disabledSites','generationMode','history']);
  if (!enabled || disabledSites.includes(new URL(tab.url).hostname)) throw new Error('预览已暂停');
  const retry = message.retry === true;
  if (!retry) {
    const saved = history.find(record => record.sourceUrl === message.url);
    if (saved) return {image:saved.image, seconds:saved.seconds, cached:true, fromHistory:true,
      recordId:saved.id, provider:saved.provider||'local', model:saved.model,
      promptHash:saved.promptHash, seed:saved.seed, width:saved.width, height:saved.height};
  }
  // Preview is read-only; cloud generation always requires an explicit button action.
  if (['cloud','codex'].includes(generationMode) && message.confirmed!==true)
    return {needsGeneration:true, confirmationRequired:true,...(generationMode==='codex' && {provider:'codex'})};
  if (generationMode==='local' && !token) throw new Error('请点开插件，填写本地连接码或选择云端生成');
  if (message.type==='preview') return {needsGeneration:true, confirmationRequired:false};
  if (busy) throw new Error('正在处理另一张图片，请稍后重试');
  busy = true;
  const job = activeJob = {url: message.url, discarded: false};
  try {
    let blob;
    if (message.data) {
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(message.data) || message.data.length > 5000000)
        throw new Error('图片格式不受支持');
      blob = await (await fetch(message.data)).blob();
    } else {
      const url = new URL(message.url);
      if (!allowedImageURL(url))
        throw new Error('暂不支持这种图片来源');
      let response;
      try {
        response = await fetch(url.href, {credentials: 'omit', redirect: 'error', cache: 'no-cache', signal: AbortSignal.timeout(12000)});
      } catch {
        throw new Error('网站图片读取失败或发生重定向，请刷新作品页后重试');
      }
      if (!response.ok) throw new Error('网站暂不允许读取这张图片');
      if (response.url && !allowedImageURL(new URL(response.url))) throw new Error('图片地址不受支持');
      blob = await limitedImage(response);
    }
    let data;
    if(generationMode==='codex'){
      if ((await chrome.storage.local.get('codexUsageAcknowledged')).codexUsageAcknowledged!==true) throw Error('请先在生成设置中连接 Codex');
      data=await codexGenerate(blob);
    }else if(generationMode==='cloud'){
      const config=await CloudConfig.active();
      data=await cloudGenerate(config,blob);
    }else{
    const response = await fetch(ENDPOINT + '/generate', {
      method: 'POST', headers: {'Content-Type': 'application/octet-stream', 'Authorization': 'Bearer ' + token,
        ...(retry ? {'X-Print-Chamber-Refresh': '1'} : {})},
      body: blob, signal: AbortSignal.timeout(45000)
    });
    try { data = await response.json(); }
    catch (error) {
      if (error.name !== 'SyntaxError') throw error;
      throw new Error('本地服务响应格式异常，请检查服务日志后重试');
    }
    if (!response.ok) throw new Error(data.error || '生成失败，请重试');
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(CLOUD_PROMPT));
    const expectedHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (generationMode==='local' && data.promptHash !== expectedHash) throw new Error('提示词版本不一致，请重启本地模型并刷新作品页');
    data.promptHash = expectedHash;
    try {
      const record = {id: crypto.randomUUID(), image: data.image, seconds: data.seconds, provider:data.provider||'local', model:data.model, sourceUrl: message.url,
        promptHash:data.promptHash, seed:data.seed, width:data.width, height:data.height,
        pageUrl: tab.url, title: (tab.title || '查看原作').slice(0,200), site: new URL(tab.url).hostname, createdAt: Date.now()};
      await updateHistory(history=>{
        if (job.discarded) return history;
        const next = [record, ...history.filter(r => r.sourceUrl !== message.url)].slice(0,48);
        while (JSON.stringify(next).length > 7000000 && next.length > 1) next.pop();
        return next;
      });
      if (!job.discarded) data.recordId = record.id;
    } catch { data.historyError = true; }
    return data;
  } finally { busy = false; activeJob = null; }
}

async function cloudGenerate(config,blob){
  // Keep the MV3 worker alive during a user-requested long-running image call.
  const keepAlive=setInterval(()=>chrome.runtime.getPlatformInfo().catch(()=>{}),20000);
  try {
    const result = await Cloud.generate(config,blob,CLOUD_PROMPT);
    try { await CloudConfig.verified(config); }
    catch { result.verificationSaveFailed = true; }
    return result;
  } finally { clearInterval(keepAlive); }
}

async function cloudAction(message){
  if(message.type==='cloud-load')return CloudConfig.publicConfig();
  if(busy)throw Error('正在生成图片，请完成后再修改设置或测试');
  busy=true;
  try{
    if(message.type==='codex-connect'){
      const {codexUsageAcknowledged}=await chrome.storage.local.get('codexUsageAcknowledged');
      if(codexUsageAcknowledged!==true)throw Error('尚未确认 Codex 额度使用');
      const result=await codexRequest({type:'connect'});
      await chrome.storage.local.set({generationMode:'codex',codexInstallation:{source:result.source,version:result.version}});
      return result;
    }
    if(message.type==='cloud-save')return await CloudConfig.save(message.config);
    if(message.type==='cloud-forget')return await CloudConfig.forget(message.provider);
    const c=await CloudConfig.active();
    if(message.type==='cloud-check')return await Cloud.check(c);
    if(message.type==='cloud-trial'){
      if(message.confirmed!==true || typeof message.data!=='string' || message.data.length>5000000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(message.data))throw Error('请选择参考图并确认试生成费用');
      const blob=await (await fetch(message.data)).blob();
      return await cloudGenerate(c,blob);
    }
    throw Error('不支持的操作');
  }finally{busy=false;}
}

function allowedImageURL(url) {
  if (url.username || url.password) return false;
  if (url.origin === ENDPOINT) return /^\/sample\/[0-4]$/.test(url.pathname);
  if (url.protocol !== 'https:' || (url.port && url.port !== '443')) return false;
  return ['artstation.com', 'artstationcdn.com', 'behance.net', 'pinterest.com', 'pinimg.com']
    .some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain));
}

async function limitedImage(response) {
  const limit = 12000000;
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) {
    await response.body?.cancel();
    throw new Error('图片格式不受支持，仅支持 JPEG、PNG 或 WebP');
  }
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('图片文件过大');
  }
  const reader = response.body.getReader(), parts = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('图片文件过大'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const blob = new Blob(parts, {type});
  const signature = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const matches = (bytes, offset = 0) => bytes.every((byte, i) => signature[offset + i] === byte);
  const valid = type === 'image/jpeg' ? matches([0xff, 0xd8, 0xff]) :
    type === 'image/png' ? matches([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) :
    matches([0x52, 0x49, 0x46, 0x46]) && matches([0x57, 0x45, 0x42, 0x50], 8);
  if (!valid) throw new Error('图片数据与格式不符，仅支持 JPEG、PNG 或 WebP');
  return blob;
}

async function pairingStatus() {
  const version = chrome.runtime.getManifest().version;
  try {
    const {extensionVersion} = await codexRequest({type:'hello', version});
    const remote = extensionVersion.split('.').map(Number);
    const current = version.split('.').map(Number);
    const difference = remote.map((n,i) => n - (current[i] || 0));
    for (let i=remote.length; i<current.length; i++) difference.push(-current[i]);
    return {available:true, update:(difference.find(n => n !== 0) || 0) > 0};
  } catch { return {available:false, update:false}; }
}
async function pairLocal(checkOnly) {
  const result = await codexRequest({type:'local-token'});
  if (result.error) throw Error(result.error);
  const {token} = result;
  if (!token) return {paired:false};
  if (!checkOnly) await chrome.storage.local.set({token});
  return {paired:true};
}
// Concurrent pairing requests share one native connection.
let pendingHello;
function hello() {
  return pendingHello ??= pairingStatus().then(async status => {
    if (status.available) await chrome.storage.session.set({lastPairingHello:Date.now()});
    return status;
  }).finally(() => { pendingHello = null; });
}
async function announceOnWake() {
  const {lastPairingHello} = await chrome.storage.session.get('lastPairingHello');
  if (lastPairingHello && Date.now() - lastPairingHello < 3600000) return;
  await hello();
}
announceOnWake().catch(() => {});
chrome.runtime.onInstalled.addListener(hello);
chrome.runtime.onStartup?.addListener(hello);
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if(typeof message?.type!=='string')return;
  if (['pairing-status','pairing-local'].includes(message.type)) {
    const trusted = ['settings.html','popup.html'].some(page => sender.url === chrome.runtime.getURL(page));
    if (sender.id !== chrome.runtime.id || !trusted) { reply({error:'仅扩展配置页面可配对'}); return; }
    const operation = message.type === 'pairing-status' ? hello() : pairLocal(message.checkOnly === true);
    operation.then(reply).catch(error => reply({error:error.message || '无法取得本地连接码'}));
    return true;
  }
  if(message.type.startsWith('cloud-') || ['codex-detect','codex-connect'].includes(message.type)){
    if(sender.id!==chrome.runtime.id || sender.url!==chrome.runtime.getURL('settings.html')){reply({error:'仅设置页面可管理生成配置'});return;}
    const operation=message.type==='codex-detect'?codexRequest({type:'detect'}):cloudAction(message);
    operation.then(reply).catch(e=>reply({error:e.message}));return true;
  }
  if(message.type==='delete-history-batch'){
    if(sender.id!==chrome.runtime.id || !Array.isArray(message.ids) || message.ids.length>48 || !message.ids.every(id=>typeof id==='string'&&id.length<200)){
      reply({error:'选择的记录无效'});return;
    }
    const ids=new Set(message.ids),removed=[];
    updateHistory(history=>history.filter(record=>{
      if(!ids.has(record.id))return true;
      removed.push(record.sourceUrl);
      if(activeJob?.url===record.sourceUrl)activeJob.discarded=true;
      return false;
    })).then(()=>{
      reply({ok:true,count:removed.length});
    }).catch(()=>reply({error:'删除失败，请重试'}));return true;
  }
  if(message.type==='delete-history'){
    if(sender.id!==chrome.runtime.id || typeof message.sourceUrl!=='string'){reply({error:'无法删除这张图片'});return}
    updateHistory(history=>{
      if(activeJob?.url===message.sourceUrl)activeJob.discarded=true;
      return history.filter(r=>r.sourceUrl!==message.sourceUrl);
    }).then(()=>{
      reply({ok:true});
    }).catch(()=>reply({error:'删除失败，请重试'}));return true;
  }
  if(message.type==='open-gallery' && sender.tab){chrome.tabs.create({url:chrome.runtime.getURL('gallery.html')});return}
  if (!['generate','preview'].includes(message.type) || !sender.tab || sender.id!==chrome.runtime.id) return;
  if (typeof message.url !== 'string' || message.url.length > 12000) {
    reply({error: '图片地址无效'}); return;
  }
  generate(message, sender.tab).then(reply).catch(error => reply({error:
    error.name === 'TimeoutError' ? '等待超时，请稍后重试' :
    error.message === 'Failed to fetch' ? '请先启动本地模型服务' : error.message
  }));
  return true;
});
