const ENDPOINT = 'http://127.0.0.1:8877';
const results = new Map();
let busy = false;
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({url: ['https://*.artstation.com/*', 'https://*.behance.net/*', 'https://*.pinterest.com/*', 'http://127.0.0.1:8877/*']});
  await Promise.allSettled(tabs.map(tab => chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['chamber-style.js', 'content.js']})));
});

async function generate(message) {
  const {token, enabled = true} = await chrome.storage.local.get(['token', 'enabled']);
  if (!enabled) throw new Error('预览已暂停');
  if (!token) throw new Error('请点开插件，填写本地连接码');
  if (results.has(message.url)) return {...results.get(message.url), cached: true};
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
    results.set(message.url, data);
    if (results.size > 24) results.delete(results.keys().next().value);
    return data;
  } finally { busy = false; }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type !== 'generate' || !sender.tab) return;
  if (typeof message.url !== 'string' || message.url.length > 12000) {
    reply({error: '图片地址无效'}); return;
  }
  generate(message).then(reply).catch(error => reply({error:
    error.name === 'TimeoutError' ? '等待超时，请稍后重试' :
    error.message === 'Failed to fetch' ? '请先启动本地模型服务' : error.message
  }));
  return true;
});
