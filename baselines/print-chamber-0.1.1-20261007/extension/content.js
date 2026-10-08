(() => {
  if (document.querySelector('print-chamber-overlay')) return;
  const host = document.createElement('print-chamber-overlay');
  const root = host.attachShadow({mode: 'open'});
  const style = document.createElement('style'); style.textContent = PRINT_CHAMBER_CSS;
  root.append(style);
  const panel = document.createElement('section');
  panel.className = 'panel'; panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', '原画立体预览');
  panel.innerHTML = `<header><span class="wordmark">PRINT CHAMBER</span><div class="controls"><button class="icon pin" title="固定预览" aria-label="固定预览" aria-pressed="false"><svg viewBox="0 0 24 24"><path d="m8 3 8 0-1 7 4 4H5l4-4zM12 14v7"/></svg></button><button class="icon close" title="关闭" aria-label="关闭预览"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div></header><div class="chamber"><div class="viewport"><div class="rail"></div><div class="scan"></div><div class="waiting"><svg viewBox="0 0 40 40"><path d="m20 5 13 7v16l-13 7-13-7V12zM7 12l13 7 13-7M20 19v16"/></svg><span role="status" aria-live="polite">图片等待生成</span><button class="retry" hidden>重试</button></div><img class="result" alt="原画的 3D 风格预览"></div><div class="bed"></div></div><div class="base"><span class="slits"></span><span class="led"></span></div><footer><span class="caption">本地生成</span><span class="timing"></span></footer>`;
  root.append(panel); document.documentElement.append(host);
  const $ = s => root.querySelector(s);
  let source, candidate, showTimer, hideTimer, version = 0, pinned = false, enabled = true, inside = false;
  chrome.storage.local.get('enabled').then(v => { enabled = v.enabled !== false; });
  chrome.storage.onChanged.addListener(changes => {
    if (changes.enabled) { enabled = changes.enabled.newValue !== false; if (!enabled) close(); }
  });
  function close() {
    clearTimeout(showTimer); clearTimeout(hideTimer); version++; host.style.display = 'none';
    hideTimer = null; showTimer = null;
    source = null; candidate = null; pinned = false; inside = false;
    $('.pin').setAttribute('aria-pressed', 'false');
  }
  function later() {
    clearTimeout(hideTimer);
    if (!pinned && !inside) hideTimer = setTimeout(close, 650);
  }
  function place() {
    if (!source) return;
    const rect = source.element.getBoundingClientRect(), width = Math.min(340, innerWidth - 24);
    const height = panel.getBoundingClientRect().height;
    let x = rect.right + 14;
    if (x + width > innerWidth - 12) x = rect.left - width - 14;
    x = Math.max(12, Math.min(x, innerWidth - width - 12));
    host.style.left = x + 'px'; host.style.top = Math.max(12, Math.min(rect.top, innerHeight - height - 12)) + 'px';
  }
  async function run(img, enteredAt = performance.now()) {
    clearTimeout(hideTimer); source = img; host.style.display = 'block';
    panel.className = 'panel'; $('.result').removeAttribute('src'); $('.retry').hidden = true;
    $('[role=status]').textContent = '图片等待生成'; $('.timing').textContent = '';
    $('.caption').textContent = '本地生成';
    const ratio = img.width / img.height;
    $('.viewport').style.height = Math.min(380, Math.max(185, 292 / ratio)) + 'px';
    place();
    const ticket = ++version, started = performance.now();
    let data;
    try {
      if (!(img.element instanceof HTMLImageElement)) throw new Error('Read background image through extension');
      const canvas = document.createElement('canvas');
      const factor = Math.min(1, 768 / Math.max(img.width, img.height));
      canvas.width = Math.round(img.width * factor); canvas.height = Math.round(img.height * factor);
      canvas.getContext('2d').drawImage(img.element, 0, 0, canvas.width, canvas.height);
      data = canvas.toDataURL('image/jpeg', .94);
    } catch { /* Cross-origin images are fetched by the extension background. */ }
    try {
      const result = await chrome.runtime.sendMessage({type: 'generate', url: img.url, data});
      if (ticket !== version) return;
      if (!result || result.error) throw new Error(result?.error || '连接已中断，请重试');
      $('.result').src = result.image;
      await $('.result').decode();
      if (ticket !== version) return;
      panel.className = 'panel revealing';
      $('.caption').textContent = result.cached ? '已生成的预览' : '本地生成';
      $('.timing').textContent = ((performance.now() - started) / 1000).toFixed(1) + ' 秒';
      setTimeout(() => {
        if (ticket !== version) return;
        panel.className = 'panel ready';
        panel.dataset.totalMs = String(Math.round(performance.now() - enteredAt));
        $('.timing').textContent = ((performance.now() - enteredAt) / 1000).toFixed(1) + ' 秒';
      }, matchMedia('(prefers-reduced-motion:reduce)').matches ? 0 : 430);
    } catch (error) {
      if (ticket !== version) return;
      panel.className = 'panel error'; $('[role=status]').textContent = error.message;
      $('.retry').hidden = false;
    }
  }
  const same = (a, b) => a && b && a.element === b.element && a.url === b.url;
  function describe(element) {
    if (!(element instanceof Element) || element === host) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) return null;
    if (element instanceof HTMLImageElement) {
      if (!element.complete || element.naturalWidth < 100 || element.naturalHeight < 100) return null;
      return {element, url: element.currentSrc || element.src, width: element.naturalWidth, height: element.naturalHeight};
    }
    if (element === document.body || element === document.documentElement) return null;
    const background = getComputedStyle(element).backgroundImage;
    const match = background.match(/^url\(["']?(.*?)["']?\)$/);
    return match ? {element, url: new URL(match[1], location.href).href, width: rect.width, height: rect.height} : null;
  }
  function findAt(x, y) {
    const stack = document.elementsFromPoint(x, y);
    if (stack.includes(host)) return null;
    for (const element of stack) {
      const direct = describe(element);
      if (direct) return direct;
      // Card overlays are often siblings of the image, rather than children of a link.
      if (element !== document.body && element !== document.documentElement) {
        for (const image of element.querySelectorAll('img')) {
          const rect = image.getBoundingClientRect();
          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            const found = describe(image); if (found) return found;
          }
        }
      }
    }
    return null;
  }
  function consider(img) {
    if (!img) {
      clearTimeout(showTimer); candidate = null;
      if (!hideTimer) later();
      return;
    }
    clearTimeout(hideTimer); hideTimer = null;
    if (same(source, img) && host.style.display === 'block') return;
    if (same(candidate, img)) return;
    clearTimeout(showTimer); candidate = img;
    const enteredAt = performance.now();
    showTimer = setTimeout(() => run(img, enteredAt), 300);
  }
  let point, scheduled = false;
  function track(event) {
    if (!enabled || pinned || event.composedPath().includes(host)) return;
    point = {x: event.clientX, y: event.clientY};
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; if (enabled && !pinned && !inside) consider(findAt(point.x, point.y)); });
  }
  document.addEventListener('pointermove', track, true);
  document.addEventListener('pointerover', track, true);
  document.addEventListener('load', event => {
    if (point && enabled && !pinned && !inside && event.target instanceof HTMLImageElement) consider(findAt(point.x, point.y));
  }, true);
  document.documentElement.addEventListener('pointerleave', () => { clearTimeout(showTimer); candidate = null; later(); });
  host.addEventListener('pointerenter', () => { inside = true; clearTimeout(hideTimer); });
  host.addEventListener('pointerleave', () => { inside = false; later(); });
  root.addEventListener('focusin', () => { inside = true; clearTimeout(hideTimer); });
  root.addEventListener('focusout', () => { if (!root.activeElement) { inside = false; later(); } });
  $('.close').onclick = close;
  $('.pin').onclick = () => { pinned = !pinned; $('.pin').setAttribute('aria-pressed', String(pinned)); };
  $('.retry').onclick = () => { if (source) run(source); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  document.addEventListener('focusin', event => {
    if (!enabled || pinned || event.composedPath().includes(host)) return;
    const img = event.target instanceof HTMLImageElement ? event.target : event.target.closest?.('a')?.querySelector('img');
    const found = describe(img);
    if (found) consider(found);
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.type === 'chamber-ping') reply({active: true, enabled});
  });
  window.addEventListener('resize', place);
  window.addEventListener('scroll', () => { if (!pinned) place(); }, {passive: true});
})();
