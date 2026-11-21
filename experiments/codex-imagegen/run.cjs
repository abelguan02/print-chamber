'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { AppServerClient } = require('./client.cjs');
const { loadDataset, prepareSample, writeReport } = require('./report.cjs');
const { isolateGeneration, cliOnPath } = require('./isolation.cjs');
const { collectImage } = require('./image.cjs');

const ROOT = path.resolve(__dirname, '../..');
const DATA = 'output/scenes-g3-20261025-060950';
const INSTRUCTION = '调用图片生成工具，以附带图片为参考，按以下要求生成 1 张图，不要写代码、不要回复其他内容。';
const TURN_MS = 300_000;
const G3_SHA256 = 'c2b9255da22505c3e2895fc2fcdbb076167405bb45cb8c68dbba7457e2c01ccb';

// Configure the native service. Only the model backend needs network access.
const SERVER_ARGS = [
  '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false',
  '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.hooks=false',
  '-c', 'features.code_mode=false', '-c', 'features.multi_agent=false',
  '-c', 'features.multi_agent_v2=false', '-c', 'features.computer_use=false',
  '-c', 'features.in_app_browser=false', '-c', 'mcp_servers={}', '-c', 'web_search="disabled"',
  '-c', 'features.shell_snapshot=false', '-c', 'check_for_update_on_startup=false',
];

function modeFrom(args) {
  if (!args.length || (args.length === 1 && args[0] === '--dry-run')) return { name: 'dry-run', count: 0 };
  if (args.length === 1 && args[0] === '--all') return { name: 'all', count: 5 };
  if (args.length === 2 && args[0] === '--limit' && /^[1-5]$/.test(args[1])) {
    return { name: 'limit', count: Number(args[1]) };
  }
  throw new Error('请选择 --dry-run、--limit 1 至 5 或 --all，三者不能混用。');
}

function childEnvironment(tempRoot) {
  const env = { TMPDIR: tempRoot, CODEX_SQLITE_HOME: tempRoot };
  for (const key of ['HOME', 'PATH', 'CODEX_HOME', 'LANG', 'LC_ALL']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function findDataset() {
  if (process.env.PRINT_CHAMBER_G3_DIR) return path.resolve(process.env.PRINT_CHAMBER_G3_DIR);
  const local = path.join(ROOT, DATA);
  try { await fs.access(local); return local; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  return path.resolve(common, '..', DATA);
}

async function pages(client, method, project) {
  const values = [];
  const seen = new Set();
  let cursor = null;
  do {
    const page = await client.request(method, { cursor, limit: 100 });
    values.push(...page.data.map(project));
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error(method + ' 重复返回同一分页位置');
    seen.add(cursor);
  } while (cursor);
  return values;
}

// Keep only the metered windows. Account identifiers and other RPC metadata
// are irrelevant to estimating a percentage-point change.
async function readLimits(client) {
  const data = await client.request('account/rateLimits/read', {});
  function windows(bucket) {
    if (!bucket) return null;
    function window(value) {
      return value ? {
        usedPercent: value.usedPercent, windowDurationMins: value.windowDurationMins, resetsAt: value.resetsAt,
      } : null;
    }
    return {
      limitId: bucket.limitId, rateLimitReachedType: bucket.rateLimitReachedType,
      credits: bucket.credits ? {
        hasCredits: bucket.credits.hasCredits, unlimited: bucket.credits.unlimited, balance: bucket.credits.balance,
      } : null,
      primary: window(bucket.primary), secondary: window(bucket.secondary),
    };
  }
  return {
    ordinaryUsageAllowed: data.ordinaryUsageAllowed ?? null,
    rateLimits: windows(data.rateLimits),
    rateLimitsByLimitId: Object.fromEntries(Object.entries(data.rateLimitsByLimitId ?? {})
      .filter(([, bucket]) => bucket).map(([id, bucket]) => [id, windows(bucket)])),
  };
}

async function preflight(client, checks, failureModes) {
  await client.request('initialize', { clientInfo: { name: 'print-chamber-spike', title: 'Print Chamber', version: '1.0' } });
  client.notify('initialized');
  checks.handshake = true;
  // Independent probe failures are useful evidence on offline and signed-out machines.
  const probes = {
    accountType: async () => (await client.request('account/read', {})).account?.type ?? 'signed-out',
    imageGeneration: async () => (await pages(client, 'experimentalFeature/list',
      f => ({ name: f.name, enabled: f.enabled }))).find(f => f.name === 'image_generation')?.enabled ?? null,
    models: () => pages(client, 'model/list', m => ({
      model: m.model, imageInput: m.inputModalities?.includes('image') ?? true, isDefault: m.isDefault,
    })),
    rateLimits: () => readLimits(client),
  };
  await Promise.all(Object.entries(probes).map(async ([name, run]) => {
    try { checks[name] = await run(); }
    catch (error) { checks.issues[name] = error.message; }
  }));
  if (checks.accountType === 'signed-out') {
    failureModes.loggedOut = 'account/read 成功返回 account=null。' +
      (checks.issues.rateLimits ? ' 读取限额时 ' + checks.issues.rateLimits + '。' : '') + ' 未发送生成请求。';
  }
  if (checks.imageGeneration === false) failureModes.featureDisabled = '功能查询返回 enabled=false；预检终止，未发送生成请求。';
  const models = (checks.models ?? []).filter(m => m.imageInput);
  checks.model = (models.find(m => m.isDefault) ?? models[0])?.model ?? null;
  checks.ready = checks.rateLimits?.ordinaryUsageAllowed !== false && checks.accountType === 'chatgpt' && checks.imageGeneration === true && !!checks.model;
}

function newRecord(source) {
  return {
    id: source.id, sourceSha256: source.sha256, attempted: false, status: 'skipped',
    startedAt: null, endedAt: null, durationMs: null, firstEventMs: null, turnStatus: null,
    imageToolCalled: false, imageToolStatus: null, referenceHashMatched: null,
    outputImage: null, format: null, width: null, height: null, reportedPath: null, reportedPathScope: null,
    sourceImage: null, fluxImage: null, reply: '', rateLimitsBefore: null, rateLimitsAfter: null,
    rateLimitErrors: {}, error: null,
  };
}

// Only one fresh thread is active. Notifications can precede the turn/start reply.
async function runTurn({ client, listen, record, source, prompt, model, tempRoot, cwd, outputDir, timeoutMs = TURN_MS }) {
  const thread = await client.request('thread/start', {
    cwd, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true, modelProvider: 'openai', model,
  });
  if (thread.approvalPolicy !== 'never' || thread.sandbox?.type !== 'readOnly' ||
      thread.sandbox.networkAccess === true || thread.modelProvider !== 'openai') {
    throw new Error('服务端未确认只读、禁审批、受限联网与 OpenAI 供应商；未提交原画。');
  }
  const threadId = thread.thread.id;
  let turnId;
  let finished;
  let timer;
  let expired = false;
  let acceptingEvents = true;
  let completedImage;
  let terminalTime;
  const texts = new Map();
  const completion = new Promise(resolve => { finished = resolve; });
  const start = performance.now();
  record.startedAt = new Date().toISOString();
  const handle = (method, params) => {
    if (!acceptingEvents || params?.threadId !== threadId) return;
    const id = params.turnId ?? params.turn?.id;
    if (!id || (turnId && turnId !== id)) return;
    turnId = id;
    if (record.firstEventMs === null) record.firstEventMs = Math.round(performance.now() - start);
    const item = params.item;
    if ((method === 'item/started' || method === 'item/completed') && item?.type === 'imageGeneration') {
      record.imageToolCalled = true;
      record.imageToolStatus = item.status;
      if (item.failure?.type === 'usageLimitExceeded') record.imageToolFailure = item.failure.type;
      if (method === 'item/completed') completedImage = item;
    }
    if (method === 'item/agentMessage/delta') {
      texts.set(params.itemId, Array.from((texts.get(params.itemId) ?? '') + params.delta).slice(0, 500).join(''));
    } else if (method === 'item/completed' && item?.type === 'agentMessage') {
      texts.set(item.id, Array.from(item.text).slice(0, 500).join(''));
    }
    if (method === 'turn/completed') {
      terminalTime = performance.now();
      record.endedAt = new Date().toISOString();
      record.turnStatus = params.turn.status;
      const reason = params.turn.error?.codexErrorInfo;
      if (reason) record.turnErrorCode = typeof reason === 'string' ? reason : Object.keys(reason)[0];
      acceptingEvents = false;
      finished();
    }
  };
  listen(handle);
  try {
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error('单张超过 5 分钟')); }, timeoutMs);
    });
    record.attempted = true;
    const submit = client.request('turn/start', {
      threadId, input: [
        { type: 'text', text: INSTRUCTION + '\n\n' + prompt },
        { type: 'localImage', path: path.join(outputDir, record.sourceImage) },
      ],
    }, timeoutMs + 1000).then(response => {
      if (turnId && turnId !== response.turn.id) throw new Error('turn/start 返回了不同的 turn ID');
      turnId = response.turn.id;
    });
    await Promise.race([
      Promise.all([submit, completion]), timedOut, client.disconnected.then(error => { throw error; }),
    ]);
    if (terminalTime - start >= timeoutMs) throw new Error('单张超过 5 分钟');
    if (completedImage) Object.assign(record, collectImage(completedImage, tempRoot, outputDir, source.id, source.sha256));
    if (record.turnStatus !== 'completed') throw new Error('turn/completed: ' + record.turnStatus +
      (record.turnErrorCode ? ' (' + record.turnErrorCode + ')' : ''));
    if (!record.outputImage || !record.imageToolCalled) throw new Error(record.error || '未收到图片工具的有效输出');
    record.status = 'success';
  } finally {
    clearTimeout(timer);
    if (expired) {
      // End the owned server if no interrupt can be acknowledged. Starting the
      // next sample in that session would risk overlapping two billable turns.
      if (turnId) {
        try {
          await client.request('turn/interrupt', { threadId, turnId }, 3000);
          await Promise.race([completion, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('未确认中断')), 3000);
          })]);
        } catch { await client.close(); }
      } else { await client.close(); }
    }
    clearTimeout(timer);
    listen(null);
    record.reply = Array.from([...texts.values()].join('\n')).slice(0, 500).join('');
    record.durationMs = Math.round((terminalTime ?? performance.now()) - start);
    record.endedAt ??= new Date().toISOString();
  }
}

async function run(mode) {
  const outputParent = path.join(ROOT, 'output');
  await fs.mkdir(outputParent, { recursive: true });
  const outputDir = await fs.mkdtemp(path.join(outputParent, 'codex-imagegen-' +
    new Date().toISOString().replace(/[:.]/g, '-') + '-'));
  const results = {
    mode: mode.name, requestedSamples: mode.count, environment: {
      codexVersion: null, nodeVersion: process.version, platform: process.platform, outerInstruction: INSTRUCTION, g3Sha256: null,
    },
    preflight: { handshake: false, ready: false, issues: {} }, failureModes: {}, records: [],
  };
  let client, listener, tempRoot, dataset, datasetDir;
  let signalled = false;
  const cancel = () => { signalled = true; if (client) void client.close(); };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  function listen(callback) { listener = callback; }
  try {
    try {
      datasetDir = await findDataset();
      dataset = await loadDataset(datasetDir);
      results.environment.g3Sha256 = dataset.g3Sha256;
      if (dataset.g3Sha256 !== G3_SHA256) throw new Error('G3 提示词与已确认版本的 SHA-256 不匹配');
    } catch (error) {
      if (mode.count) throw error;
      results.datasetError = error.message;
    }
    for (const source of dataset?.sources.slice(0, mode.count) ?? []) {
      const record = newRecord(source);
      results.records.push(record);
      try { Object.assign(record, await prepareSample(datasetDir, source, outputDir)); }
      catch (error) { record.error = error.message; }
    }
    tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-imagegen-')));
    const cwd = path.join(tempRoot, 'work');
    await fs.mkdir(cwd);
    const baseEnv = childEnvironment(tempRoot);
    const cliPath = await cliOnPath(baseEnv.PATH, cwd);
    results.environment.codexVersion = execFileSync(cliPath, ['--version'], {
      cwd, env: baseEnv, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // A ready dry run must prove that the *same* confined server can start.
    const env = await isolateGeneration(tempRoot, baseEnv);
    client = new AppServerClient({ cwd, env, args: SERVER_ARGS, onNotification: (m, p) => listener?.(m, p) });
    results.serverPid = client.pid;
    await preflight(client, results.preflight, results.failureModes);
    let quotaBlocked = results.preflight.rateLimits?.ordinaryUsageAllowed === false;
    for (const record of results.records) {
      if (record.error) continue;
      if (quotaBlocked) { record.error = '账号已报告当前额度受限，未提交本张原画。'; continue; }
      if (!results.preflight.ready || signalled) {
        record.error = '预检未就绪或已终止，未提交本张原画。';
        continue;
      }
      const source = dataset.sources[record.id - 1];
      try { record.rateLimitsBefore = await readLimits(client); }
      catch (error) { record.rateLimitErrors.before = error.message; }
      if (record.rateLimitsBefore?.ordinaryUsageAllowed === false) {
        quotaBlocked = true;
        record.error = '提交前账号已拒绝额度，未出图。';
        continue;
      }
      try {
        await runTurn({ client, listen, record, source, prompt: dataset.g3,
          model: results.preflight.model, tempRoot, cwd, outputDir });
      } catch (error) {
        record.status = record.attempted ? 'failed' : 'skipped';
        record.error = error.message;
      }
      if (record.turnErrorCode === 'usageLimitExceeded' || record.imageToolFailure === 'usageLimitExceeded') {
        quotaBlocked = true;
        results.failureModes.quotaExhausted = '服务端返回 usageLimitExceeded。';
      }
      try { record.rateLimitsAfter = await readLimits(client); }
      catch (error) { record.rateLimitErrors.after = error.message; }
      if (record.rateLimitsAfter?.ordinaryUsageAllowed === false) quotaBlocked = true;
    }
  } catch (error) {
    if (!results.preflight.handshake && error.code === 'APP_SERVER_EXITED') {
      results.preflight.issues.startup = error.message;
      results.error = 'Codex 在出图隔离条件下未完成握手就退出了（' + error.message + '）。未提交图片。';
    } else {
      results.error = error.message;
    }
    for (const record of results.records) record.error ??= results.error;
  } finally {
    try {
      if (client) await client.close();
      if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
    } finally {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
      await writeReport(outputDir, results);
    }
  }
  console.log('报告 ' + outputDir);
  console.log('握手 ' + (results.preflight.handshake ? '完成' : '失败') + '，生成预检 ' +
    (results.preflight.ready ? '就绪' : '未就绪') + '，已提交 ' + results.records.filter(r => r.attempted).length + ' 张');
  if (results.error) console.error(results.error);
  return !signalled && !results.error && results.preflight.handshake &&
    (!mode.count || results.records.every(r => r.status === 'success'));
}

if (require.main === module) {
  Promise.resolve().then(() => run(modeFrom(process.argv.slice(2))))
    .then(ok => { process.exitCode = ok ? 0 : 1; })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { INSTRUCTION, modeFrom, preflight, runTurn };
