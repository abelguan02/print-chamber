const $ = selector => document.querySelector(selector);
let saved;
let working = false;

for (const [id, provider] of Object.entries(Cloud.providers)) {
  $('#provider').add(new Option(provider.name, id));
}

async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result || result.error) throw Error(result?.error || '设置服务未响应 · 重新加载扩展');
  return result;
}

function visibility() {
  const cloud = $('#mode').value === 'cloud';
  $('#cloud-fields').hidden = !cloud;
  $('#trial-section').hidden = !cloud;
  $('#local-note').hidden = $('#mode').value !== 'local';
  const codex = $('#mode').value === 'codex';
  $('#codex-fields').hidden = !codex;
  $('#save-settings').hidden = codex;
}

function providerFields() {
  const id = $('#provider').value;
  const config = saved.configs[id];
  $('#key').value = '';
  $('#key').placeholder = config.hasKey ? '输入新 Key 可替换' : '粘贴 API Key';
  $('#key-state').textContent = config.hasKey ? '密钥已保存' : '';
  $('#key-state').hidden = !config.hasKey;
  $('#forget').hidden = !config.hasKey;
  $('#ali-fields').hidden = id !== 'ali';
  $('#region').value = config.region || 'cn-beijing';
  $('#workspace').value = config.workspace || '';
  const models = Cloud.providers[id].models;
  $('#model').replaceChildren(...models.map(model => new Option(model, model)));
  $('#model').value = config.model || models[0];

  $('#verification').textContent = config.verifiedAt
    ? '上次生成成功 · ' + new Date(config.verifiedAt).toLocaleString()
    : '';
  $('#verification').hidden = !config.verifiedAt;
}

function clearResult() {
  $('#preview').hidden = true;
  $('#preview').removeAttribute('src');
  $('#download').hidden = true;
  $('#download').removeAttribute('href');
}

async function acknowledgeCloudCharge() {
  const {cloudChargeAcknowledged} = await chrome.storage.local.get('cloudChargeAcknowledged');
  if (cloudChargeAcknowledged === true) return true;
  if (!confirm('云端生成会上传原画到所选供应商，并按次计费。继续？')) {
    $('#notice').textContent = '已取消';
    return false;
  }
  await chrome.storage.local.set({cloudChargeAcknowledged: true});
  return true;
}

async function save() {
  const mode = $('#mode').value;
  if (mode === 'local') await LocalSettings.save();
  saved = await send({type: 'cloud-save', config: {
    mode,
    provider: $('#provider').value,
    key: $('#key').value,
    model: $('#model').value,
    workspace: $('#workspace').value.trim(),
    region: $('#region').value
  }});
  providerFields();
}

async function action(fn) {
  if (working) return;
  working = true;
  $('#fields').disabled = true;
  $('#notice').textContent = '正在处理…';
  try {
    await fn();
  } catch (error) {
    $('#notice').textContent = error.message;
  } finally {
    working = false;
    $('#fields').disabled = false;
  }
}

$('#mode').onchange = () => {
  $('#notice').textContent = '';
  visibility();
  clearResult();
  if ($('#mode').value === 'codex') $('#notice').textContent = saved.mode === 'codex' ? '已启用' : '未连接';
};
$('#provider').onchange = () => {
  providerFields();
  clearResult();
  $('#notice').textContent = '';
};
for (const id of ['key', 'region', 'workspace', 'model']) {
  $('#' + id).addEventListener('input', () => {
    $('#verification').hidden = true;
    $('#notice').textContent = '';
    clearResult();
  });
}

$('#settings').onsubmit = event => {
  event.preventDefault();
  if ($('#mode').value === 'codex') return;
  action(async () => {
    if ($('#mode').value === 'cloud' && !await acknowledgeCloudCharge()) return;
    await save();
    $('#notice').textContent = saved.mode === 'cloud' ? '已启用云端生成' : '已保存';
  });
};

$('#codex-connect').onclick = () => action(async () => {
  const {codexUsageAcknowledged} = await chrome.storage.local.get('codexUsageAcknowledged');
  if (codexUsageAcknowledged !== true) {
    if (!confirm('Codex 生成会把原画发送给 OpenAI，并消耗你的 Codex 额度。继续？')) {
      $('#notice').textContent = '已取消';
      return;
    }
    await chrome.storage.local.set({codexUsageAcknowledged:true});
  }
  const connection = await send({type:'codex-connect'});
  saved.mode = 'codex';
  $('#notice').textContent = connection.source === 'standalone' ? '已连接 · 独立版' : '已连接 · 桌面版';
});

$('#local-check').onclick = () => action(async () => {
  $('#notice').textContent = '';
  await LocalSettings.check();
});

$('#check').onclick = () => action(async () => {
  if (!await acknowledgeCloudCharge()) return;
  await save();
  $('#notice').textContent = '检查中…';
  const result = await send({type: 'cloud-check'});
  $('#notice').textContent = result.authenticated ? '模型查询通过' : '接口可达';
});

$('#forget').onclick = () => action(async () => {
  saved = await send({type: 'cloud-forget', provider: $('#provider').value});
  if (!Object.values(saved.configs).some(config => config.hasKey)) {
    await chrome.storage.local.remove('cloudChargeAcknowledged');
  }
  $('#mode').value = saved.mode;
  providerFields();
  visibility();
  clearResult();
  $('#notice').textContent = '密钥已删除';
});

$('#trial').onclick = () => action(async () => {
  const file = $('#file').files[0];
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 12000000) {
    throw Error('请选择 12 MB 以内的 PNG、JPEG 或 WebP 原画');
  }
  if (!await acknowledgeCloudCharge()) return;
  const data = await Cloud.prepare(file, 1536);
  await save();
  clearResult();
  $('#notice').textContent = '正在生成…';
  const result = await send({type: 'cloud-trial', data, confirmed: true});
  $('#preview').src = result.image;
  await $('#preview').decode();
  $('#preview').hidden = false;
  $('#download').href = result.image;
  $('#download').hidden = false;
  saved = await send({type: 'cloud-load'});
  providerFields();
  $('#notice').textContent = `生成完成 · ${result.seconds.toFixed(1)} 秒`;
});

Promise.all([send({type: 'cloud-load'}), chrome.storage.local.get(['generationMode', 'token']),
  chrome.runtime.sendMessage({type:'codex-detect'})])
  .then(([config, local, detection]) => {
    if (detection?.found) $('#mode').add(new Option('本机 Codex', 'codex'));
    const firstUse = !local.generationMode && !local.token && !Object.values(config.configs).some(c => c.hasKey);
    saved = config;
    const missing = config.mode === 'codex' && !detection?.found;
    $('#mode').value = firstUse || missing ? 'cloud' : config.mode;
    if (detection?.error || missing) $('#notice').textContent = detection?.error || '未找到 Codex';
    else if (config.mode === 'codex') $('#notice').textContent = '已启用';
    $('#provider').value = config.provider;
    providerFields();
    visibility();
    $('#fields').disabled = false;
  })
  .catch(error => { $('#notice').textContent = error.message; });
