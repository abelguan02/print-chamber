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
  function bindManualEntry(field) {
    async function lookup(checkOnly) {
      if (await ready) {
        const result = await chrome.runtime.sendMessage({type:'pairing-local', checkOnly});
        field.hidden = result?.paired === true;
        if (!result || result.error) throw Error(result?.error || '本机助手未响应');
        return field.hidden;
      }
      field.hidden = false;
      return false;
    }
    // Inspect on open without replacing an existing manual code or triggering a health check.
    const inspected = lookup(true).catch(() => { field.hidden = false; });
    return async function localToken() {
      await inspected;
      if (!await lookup(false)) return null;
      return (await chrome.storage.local.get('token')).token;
    };
  }
  return {ready, bindManualEntry};
})();
