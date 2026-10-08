const ENDPOINT = 'http://127.0.0.1:8877';
const results = new Map();
let busy = false;
// Serialize additions and deletions so an in-flight print cannot restore a deleted record.
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
  const {token, enabled = true, disabledSites = []} = await chrome.storage.local.get(['token', 'enabled', 'disabledSites']);
  if (!enabled || disabledSites.includes(new URL(tab.url).hostname)) throw new Error('预览已暂停');
  if (!token) throw new Error('请点开插件，填写本地连接码');
  if (!message.retry && results.has(message.url)) return {...results.get(message.url), cached: true};
  if (busy) throw new Error('正在处理另一张图片，请稍后重试');
  busy = true;
  try {
    let blob;
    if (message.data) {
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(message.data) || message.data.length > 5000000)
        throw new Error('图片格式不受支持');
      blob = await (await fetch(message.data)).blob();
    } else {
      const url = new URL(message.url);
      if (url.protocol !== 'https:' && !(url.origin === ENDPOINT && /^\/sample\/[0-4]$/.test(url.pathname)))
        throw new Error('暂不支持这种图片来源');
      if (url.protocol === 'https:' && (/^(localhost|127\.|10\.|192\.168\.|\[)/.test(url.hostname)))
        throw new Error('图片地址不受支持');
      const response = await fetch(url.href, {credentials: 'omit', signal: AbortSignal.timeout(12000)});
      if (!response.ok) throw new Error('网站暂不允许读取这张图片');
      if (Number(response.headers.get('content-length')) > 12000000) throw new Error('图片文件过大');
      blob = await response.blob();
      if (blob.size > 12000000) throw new Error('图片文件过大');
    }
    const response = await fetch(ENDPOINT + '/generate', {
      method: 'POST', headers: {'Content-Type': 'application/octet-stream', 'Authorization': 'Bearer ' + token},
      body: blob, signal: AbortSignal.timeout(45000)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '生成失败，请重试');
    try {
      const record = {id: crypto.randomUUID(), image: data.image, seconds: data.seconds, sourceUrl: message.url,
        pageUrl: tab.url, title: (tab.title || '查看原作').slice(0,200), site: new URL(tab.url).hostname, createdAt: Date.now()};
      await updateHistory(history=>{
        const next = [record, ...history.filter(r => r.sourceUrl !== message.url)].slice(0,48);
        while (JSON.stringify(next).length > 7000000 && next.length > 1) next.pop();
        return next;
      });
      data.recordId = record.id;
    } catch { data.historyError = true; }
    results.set(message.url, data);
    if (results.size > 24) results.delete(results.keys().next().value);
    return data;
  } finally { busy = false; }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if(message.type==='delete-history-batch'){
    if(sender.id!==chrome.runtime.id || !Array.isArray(message.ids) || message.ids.length>48 || !message.ids.every(id=>typeof id==='string'&&id.length<200)){
      reply({error:'选择的记录无效'});return;
    }
    const ids=new Set(message.ids),removed=[];
    updateHistory(history=>history.filter(record=>{if(!ids.has(record.id))return true;removed.push(record.sourceUrl);return false})).then(()=>{
      removed.forEach(url=>results.delete(url));reply({ok:true,count:removed.length});
    }).catch(()=>reply({error:'删除失败，请重试'}));return true;
  }
  if(message.type==='delete-history'){
    if(sender.id!==chrome.runtime.id || typeof message.sourceUrl!=='string'){reply({error:'无法删除这张图片'});return}
    updateHistory(history=>history.filter(r=>r.sourceUrl!==message.sourceUrl)).then(()=>{
      results.delete(message.sourceUrl);reply({ok:true});
    }).catch(()=>reply({error:'删除失败，请重试'}));return true;
  }
  if(message.type==='open-gallery' && sender.tab){chrome.tabs.create({url:chrome.runtime.getURL('gallery.html')});return}
  if (message.type !== 'generate' || !sender.tab) return;
  if (typeof message.url !== 'string' || message.url.length > 12000) {
    reply({error: '图片地址无效'}); return;
  }
  generate(message, sender.tab).then(reply).catch(error => reply({error:
    error.name === 'TimeoutError' ? '等待超时，请稍后重试' :
    error.message === 'Failed to fetch' ? '请先启动本地模型服务' : error.message
  }));
  return true;
});
