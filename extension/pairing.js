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
    let errorMessage = '';
    async function lookup(checkOnly) {
      errorMessage = '';
      try {
        if (await ready) {
          const result = await chrome.runtime.sendMessage({type:'pairing-local', checkOnly});
          if (!result || result.error) throw Error(result?.error || '本机助手未响应');
          field.hidden = result.paired === true;
          return field.hidden;
        }
      } catch (error) { errorMessage = error.message; }
      field.hidden = false;
      return false;
    }
    const inspected = lookup(true);
    return {
      get error() { return errorMessage; },
      async localToken() {
        await inspected;
        if (!await lookup(false)) return null;
        return (await chrome.storage.local.get('token')).token;
      }
    };
  }
  return {ready, bindManualEntry};
})();
