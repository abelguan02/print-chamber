'use strict';
// Read the installed manifest; never display a hard-coded release or update claim.
const versionButton = document.querySelector('#copy-version');
const versionText = document.querySelector('#version');
const copyStatus = document.querySelector('#copy-status');
let installedVersion = '';
async function loadVersion() {
  try {
    const manifest = globalThis.chrome?.runtime?.getManifest
      ? chrome.runtime.getManifest()
      : await fetch('manifest.json').then(response => { if (!response.ok) throw new Error(); return response.json(); });
    installedVersion = manifest.version;
    if (typeof installedVersion !== 'string' || !/^\d+(\.\d+){1,3}$/.test(installedVersion)) throw new Error();
    versionText.textContent = 'v' + installedVersion;
    versionButton.disabled = false;
    versionButton.setAttribute('aria-label', '复制 Print Chamber v' + installedVersion + ' 版本信息');
  } catch {
    versionText.textContent = '版本未读取';
    copyStatus.textContent = '请从插件面板打开关于页';
  }
}
versionButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText('Print Chamber v' + installedVersion);
    copyStatus.textContent = '版本信息已复制';
  } catch {
    copyStatus.textContent = '复制失败，可手动复制：Print Chamber v' + installedVersion;
  }
});
loadVersion();
