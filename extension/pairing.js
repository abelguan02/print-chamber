'use strict';
// Runs only on the popup and settings pages. The worker keeps the native reply private.
const Pairing = (() => {
  const ready = chrome.runtime.sendMessage({type:'pairing-status'}).then(result => {
    if (result?.update) {
      const button = document.querySelector('#update-extension');
      button.hidden = false;
      button.onclick = () => chrome.runtime.reload();
    }
    return !!result?.available;
  });
  async function localToken(required=true) {
    const result = await chrome.runtime.sendMessage({type:'pairing-local'});
    if (!result || result.error) throw Error(result?.error || '本机助手未响应');
    if (!result.paired) {
      if (required) throw Error('尚无连接码 · 请先启动本地模型');
      return null;
    }
    return (await chrome.storage.local.get('token')).token;
  }
  return {ready, localToken};
})();
