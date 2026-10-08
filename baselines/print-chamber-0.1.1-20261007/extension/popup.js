const token = document.querySelector('#token'), enabled = document.querySelector('#enabled'), status = document.querySelector('#status');
chrome.storage.local.get(['token', 'enabled']).then(v => { token.value = v.token || ''; enabled.checked = v.enabled !== false; });
document.querySelector('#save').onclick = async () => {
  if (!token.value.trim()) { status.textContent = '请输入终端中的连接码'; return; }
  await chrome.storage.local.set({token: token.value.trim()}); status.textContent = '连接码已保存'; check();
};
enabled.onchange = () => chrome.storage.local.set({enabled: enabled.checked});
async function check() {
  try {
    const {token: saved} = await chrome.storage.local.get('token');
    const r = await fetch('http://127.0.0.1:8877/health', {headers: saved ? {Authorization: 'Bearer ' + saved} : {}, signal: AbortSignal.timeout(2000)});
    const s = await r.json();
    status.textContent = !r.ok ? s.error : !saved ? '服务已启动，请填写连接码' : s.failed ? '模型加载失败，请检查终端' : s.ready ? '本地模型已就绪' : '模型正在准备…';
  } catch { status.textContent = '请先启动 start-local.command'; }
}
check();
async function currentPage(activate = false) {
  const state = document.querySelector('#page-status');
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.url || !/^https:\/\/([^/]+\.)?(artstation\.com|behance\.net|pinterest\.com)\//.test(tab.url) && !tab.url.startsWith('http://127.0.0.1:8877/')) {
      state.textContent = '请在支持的网站作品页中打开插件'; return;
    }
    if (activate) {
      await chrome.storage.local.set({enabled:true}); enabled.checked = true;
      await chrome.scripting.executeScript({target:{tabId:tab.id},files:['chamber-style.js','content.js']});
    }
    const result = await chrome.tabs.sendMessage(tab.id, {type:'chamber-ping'});
    state.textContent = result.enabled ? '当前页已启用，将鼠标移到作品上即可' : '当前页已加载，悬停预览已暂停';
  } catch { state.textContent = '当前页尚未加载，请点“启用当前页”或刷新网页'; }
}
document.querySelector('#activate').onclick = () => currentPage(true);
currentPage();
