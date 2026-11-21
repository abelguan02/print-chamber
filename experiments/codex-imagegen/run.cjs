'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { AppServerClient } = require('./client.cjs');
const { loadDataset, prepareSample, writeReport } = require('./report.cjs');
const { isolateGeneration, isolateLoginCheck } = require('./isolation.cjs');
const { findDesktopCli } = require('./desktop-cli.cjs');
const { collectImage } = require('./image.cjs');
const { temporaryLoginEnvironment, loginInTerminal } = require('./login-check.cjs');

const ROOT = path.resolve(__dirname, '../..');
const DATA = 'output/scenes-g3-20261025-060950';
const INSTRUCTION = '调用图片生成工具，以附带图片为参考，按以下要求生成 1 张图，不要写代码、不要回复其他内容。';
const TURN_MS = 300_000;
const G3_SHA256 = 'c2b9255da22505c3e2895fc2fcdbb076167405bb45cb8c68dbba7457e2c01ccb';

// Configure the native service. Only the model backend needs network access.
const SERVER_ARGS = [
  '-c', 'model_provider="openai"',
  '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false',
  '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.hooks=false',
  '-c', 'features.code_mode=false', '-c', 'features.multi_agent=false',
  '-c', 'features.multi_agent_v2=false', '-c', 'features.computer_use=false',
  '-c', 'features.in_app_browser=false', '-c', 'mcp_servers={}', '-c', 'web_search="disabled"',
  '-c', 'features.shell_snapshot=false', '-c', 'check_for_update_on_startup=false',
];

function modeFrom(args) {
  if (!args.length || (args.length === 1 && args[0] === '--dry-run')) return { name: 'dry-run', count: 0 };
  if (args.length === 1 && args[0] === '--check-existing-login') return { name: 'check-existing-login', count: 0 };
  if (args.length === 1 && args[0] === '--check-image-capability') return { name: 'check-image-capability', count: 0 };
  if (args.length === 1 && args[0] === '--login-check') return { name: 'login-check', count: 0 };
  if (args.length === 1 && args[0] === '--login-first-image') return { name: 'login-first-image', count: 1 };
  if (args.length === 1 && args[0] === '--all') return { name: 'all', count: 5 };
  if (args.length === 2 && args[0] === '--limit' && /^[1-5]$/.test(args[1])) {
    return { name: 'limit', count: Number(args[1]) };
  }
  throw new Error('请选择 --dry-run、--check-existing-login、--check-image-capability、--login-check、--login-first-image、--limit 1 至 5 或 --all，各模式不能混用。');
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
      limitId: bucket.limitId, rateLimitReachedType: bucket.rateLimitReachedType, spendControlReached: bucket.spendControlReached,
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

async function handshake(client) {
  await client.request('initialize', { clientInfo: { name: 'print-chamber-spike', title: 'Print Chamber', version: '1.0' } });
  client.notify('initialized');
}

async function confirmChatgpt(client, checks, failureModes) {
  await handshake(client);
  checks.handshake = true;
  let response;
  try { response = await client.request('account/read', { refreshToken: false }); }
  catch (error) { throw new Error('无法确认已有登录，已停止（' + error.message + '）。'); }
  const account = response?.account;
  checks.accountType = account === null ? 'signed-out' :
    (['chatgpt', 'apiKey'].includes(account?.type) ? account.type : 'unknown');
  if (checks.accountType === 'signed-out') {
    failureModes.loggedOut = 'account/read 返回 account=null，未提交原画。';
    throw new Error('本次连接未识别到已有登录，已停止。');
  }
  if (checks.accountType !== 'chatgpt') throw new Error('无法确认已有 ChatGPT 登录，已停止。');
}

async function preflight(client, checks, failureModes) {
  await confirmChatgpt(client, checks, failureModes);
  const probes = {
    imageGeneration: async () => (await pages(client, 'experimentalFeature/list',
      f => ({ name: f.name, enabled: f.enabled }))).find(f => f.name === 'image_generation')?.enabled ?? null,
    providerImageGeneration: async () => (await client.request('modelProvider/capabilities/read', {})).imageGeneration,
    // The CLI schema defaults an omitted inputModalities to ["text", "image"].
    models: () => pages(client, 'model/list', m => ({
      model: m.model, imageInput: m.inputModalities === undefined || m.inputModalities?.includes('image') === true, isDefault: m.isDefault,
    })),
    rateLimits: () => readLimits(client),
  };
  await Promise.all(Object.entries(probes).map(async ([name, run]) => {
    try { checks[name] = await run(); }
    catch (error) { checks.issues[name] = error.message; }
  }));
  if (checks.imageGeneration === false) failureModes.featureDisabled = '功能查询返回 enabled=false；预检终止，未发送生成请求。';
  const models = (checks.models ?? []).filter(m => m.imageInput);
  checks.model = (models.find(m => m.isDefault) ?? models[0])?.model ?? null;
  if (checks.providerImageGeneration === false) checks.issues.providerImageGeneration = '供应商报告不支持图片生成。';
  if (!checks.model) checks.issues.models ??= '未找到支持图片输入的模型。';
  if (checks.imageGeneration !== true) checks.issues.imageGeneration ??= '未确认图片生成功能已开启。';
  if (checks.providerImageGeneration !== true) checks.issues.providerImageGeneration ??= '未确认供应商支持图片生成。';
  if (checks.rateLimits?.ordinaryUsageAllowed === false) checks.issues.quota = '账号报告当前额度受限。';
  checks.ready = checks.rateLimits?.ordinaryUsageAllowed !== false && checks.accountType === 'chatgpt' &&
    checks.imageGeneration === true && checks.providerImageGeneration === true && !!checks.model;
}

function summarizeCapabilities(checks, completed) {
  const limits = checks.rateLimits;
  const permission = limits?.ordinaryUsageAllowed;
  const codexBucket = limits?.rateLimitsByLimitId?.codex ??
    (limits?.rateLimits?.limitId === 'codex' ? limits.rateLimits : null);
  const codexLimitReason = codexBucket?.rateLimitReachedType ?? null;
  return {
    handshake: checks.handshake, accountType: checks.accountType ?? null,
    imageGeneration: checks.imageGeneration ?? null, providerImageGeneration: checks.providerImageGeneration ?? null,
    model: checks.model ?? null, quotaStatus: permission === true ? 'allowed' : permission === false ? 'blocked' : 'unknown',
    codexLimitReason, codexSpendControlReached: codexBucket?.spendControlReached ?? null,
    ready: completed && checks.ready && codexLimitReason === null, issues: checks.issues,
  };
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
async function runTurn({ client, listen, record, source, prompt, model, tempRoot, cwd, outputDir, allowedImageRoots, timeoutMs = TURN_MS }) {
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
    if (completedImage) Object.assign(record, collectImage(completedImage, tempRoot, outputDir, source.id, source.sha256, allowedImageRoots));
    if (record.turnStatus !== 'completed') throw new Error('turn/completed: ' + record.turnStatus +
      (record.turnErrorCode ? ' (' + record.turnErrorCode + ')' : ''));
    if (!record.imageToolCalled) throw new Error('本次会话未观测到图片生成工具调用，未收到有效输出');
    if (!record.outputImage) throw new Error(record.error || '已观测到图片工具调用，但未收到有效输出');
    if (record.referenceHashMatched === false) throw new Error(`已取得图片，但图片工具记录的输入与第 ${source.id} 张原画不符。`);
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
  const loginCheck = mode.name === 'login-check';
  const existingLoginOnly = mode.name === 'check-existing-login';
  const capabilityOnly = mode.name === 'check-image-capability';
  const desktopQuery = existingLoginOnly || capabilityOnly;
  const firstImage = mode.name === 'login-first-image';
  const temporaryLogin = loginCheck || firstImage;
  if (temporaryLogin && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('请在自己的终端窗口运行临时登录命令。');
  }
  const outputParent = path.join(ROOT, 'output');
  await fs.mkdir(outputParent, { recursive: true });
  const outputPrefix = {
    'check-existing-login': 'codex-existing-login-', 'check-image-capability': 'codex-image-capability-',
  }[mode.name] ?? 'codex-imagegen-';
  const outputDir = await fs.mkdtemp(path.join(outputParent, outputPrefix +
    new Date().toISOString().replace(/[:.]/g, '-') + '-'));
  const results = {
    mode: mode.name, requestedSamples: mode.count, environment: {
      codexVersion: null, nodeVersion: process.version, platform: process.platform, outerInstruction: INSTRUCTION, g3Sha256: null,
    },
    preflight: { handshake: false, ready: false, issues: {} }, failureModes: {}, records: [],
  };
  if (!temporaryLogin && !capabilityOnly) results.existingLogin = {
    first: { started: false, handshake: false, accountType: null },
    reconnect: { started: false, handshake: false, accountType: null }, verified: false,
  };
  let client, listener, tempRoot, dataset, datasetDir, activeCheck;
  const cancellation = new AbortController();
  const cancel = () => {
    cancellation.abort(new Error('已取消本次运行。'));
    if (client) void client.close();
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  function listen(callback) { listener = callback; }
  async function execute() {
    if (!loginCheck && !desktopQuery) {
      try {
        datasetDir = await findDataset();
        dataset = await loadDataset(datasetDir);
        results.environment.g3Sha256 = dataset.g3Sha256;
        if (dataset.g3Sha256 !== G3_SHA256) throw new Error('G3 提示词与已确认版本的 SHA-256 不匹配');
      } catch (error) {
        if (mode.count) throw error;
        results.datasetError = error.message;
      }
    }
    for (const source of dataset?.sources.slice(0, mode.count) ?? []) {
      const record = newRecord(source);
      results.records.push(record);
      try { Object.assign(record, await prepareSample(datasetDir, source, outputDir)); }
      catch (error) {
        record.error = error.message;
        if (mode.count === 1) throw error;
      }
    }
    tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-imagegen-')));
    const cwd = path.join(tempRoot, 'work');
    await fs.mkdir(cwd);
    const baseEnv = temporaryLogin
      ? await temporaryLoginEnvironment(tempRoot, process.env)
      : childEnvironment(tempRoot);
    const cliPath = await findDesktopCli();
    results.environment.codexSource = 'chatgpt-desktop-bundle';
    results.environment.codexExecutable = cliPath;
    const isolate = desktopQuery ? isolateLoginCheck : isolateGeneration;
    const env = await isolate(tempRoot, baseEnv, cliPath);
    results.environment.codexVersion = execFileSync('codex', ['--version'], {
      cwd, env, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const startServer = () => new AppServerClient({
      cwd, env, args: SERVER_ARGS, onNotification: (method, params) => listener?.(method, params),
    });
    cancellation.signal.throwIfAborted();
    if (capabilityOnly) {
      activeCheck = results.preflight;
      client = startServer();
      await preflight(client, activeCheck, results.failureModes);
      cancellation.signal.throwIfAborted();
      return;
    }
    if (temporaryLogin) {
      results.loginCheck = { startupVerified: false, loginCompleted: false };
      client = startServer();
      await handshake(client);
      results.loginCheck.startupVerified = true;
      await client.close();
      client = null;
      console.log('启动检查通过。请在官方登录页面选择你的 ChatGPT 账号，完成后回到本终端。');
      await loginInTerminal(cliPath, cwd, baseEnv, cancellation.signal);
      results.loginCheck.loginCompleted = true;
    } else {
      activeCheck = results.existingLogin.first;
      client = startServer();
      activeCheck.started = true;
      await confirmChatgpt(client, activeCheck, results.failureModes);
      await client.close();
      client = null;
    }
    cancellation.signal.throwIfAborted();
    activeCheck = existingLoginOnly ? results.existingLogin.reconnect : results.preflight;
    client = startServer();
    results.serverPid = client.pid;
    if (results.existingLogin) results.existingLogin.reconnect.started = true;
    if (existingLoginOnly) await confirmChatgpt(client, activeCheck, results.failureModes);
    else await preflight(client, results.preflight, results.failureModes);
    let quotaBlocked = results.preflight.rateLimits?.ordinaryUsageAllowed === false;
    for (const record of results.records) {
      if (record.error) continue;
      if (quotaBlocked) { record.error = '账号已报告当前额度受限，未提交本张原画。'; continue; }
      if (!results.preflight.ready || cancellation.signal.aborted) {
        record.error = results.preflight.issues.providerImageGeneration ?? '预检未就绪或已终止，未提交本张原画。';
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
      cancellation.signal.throwIfAborted();
      if (mode.count === 1) console.log((firstImage ? '登录预检通过' : '两次连接均识别到已有 ChatGPT 登录') + '，正在处理第 1 张原画。');
      try {
        await runTurn({ client, listen, record, source, prompt: dataset.g3,
          model: results.preflight.model, tempRoot, cwd, outputDir,
          allowedImageRoots: firstImage ? [cwd, path.join(baseEnv.CODEX_HOME, 'generated_images')] : undefined });
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
  }
  try {
    await execute();
  } catch (error) {
    if (desktopQuery && cancellation.signal.aborted) {
      results.error = '已取消本次检查。';
    } else if (desktopQuery && !activeCheck?.handshake && error.code === 'APP_SERVER_EXITED') {
      results.error = 'Codex 在查询账号前退出（' + error.message + '）。';
    } else if (!activeCheck?.handshake && error.code === 'APP_SERVER_EXITED') {
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
      if (results.existingLogin) {
        const { first, reconnect } = results.existingLogin;
        if (!existingLoginOnly) {
          reconnect.handshake = results.preflight.handshake;
          reconnect.accountType = results.preflight.accountType ?? null;
        }
        results.existingLogin.verified = !cancellation.signal.aborted &&
          first.accountType === 'chatgpt' && reconnect.accountType === 'chatgpt';
      }
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
      if (desktopQuery) {
        const { codexSource, codexVersion } = results.environment;
        const report = { mode: mode.name, environment: { codexSource, codexVersion }, submitted: 0, error: results.error ?? null };
        if (capabilityOnly) {
          results.preflight = summarizeCapabilities(results.preflight, !results.error && !cancellation.signal.aborted);
          report.preflight = results.preflight;
        } else report.existingLogin = results.existingLogin;
        await fs.writeFile(path.join(outputDir, 'results.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
      } else await writeReport(outputDir, results);
    }
  }
  console.log('报告 ' + outputDir);
  if (results.error) console.error(results.error);
  if (capabilityOnly) {
    const checks = results.preflight;
    if (checks.accountType !== 'chatgpt') {
      console.log('出图能力未查询，已提交 0 张。');
      return false;
    }
    const state = (value, yes, no) => value === null ? '未知' : value ? yes : no;
    console.log('出图开关 ' + state(checks.imageGeneration, '开启', '关闭') +
      '，服务 ' + state(checks.providerImageGeneration, '支持出图', '不支持出图') +
      '，图片输入模型 ' + (checks.model ?? '未确认') +
      '，普通额度 ' + { allowed: '可用', blocked: '受限', unknown: '未知' }[checks.quotaStatus] + '。');
    if (checks.codexLimitReason) console.log('Codex 服务报告了额度限制（' + checks.codexLimitReason + '）。');
    if (checks.codexSpendControlReached) console.log('Codex 服务报告已达到支出上限。');
    for (const issue of Object.values(checks.issues)) console.error(issue);
    console.log('出图预检' + (checks.ready ? '通过' : '未通过') + '，已提交 0 张。');
    return checks.ready;
  }
  if (existingLoginOnly) {
    const accountLabels = { chatgpt: 'ChatGPT 已登录', 'signed-out': '未登录', apiKey: 'API Key' };
    const status = check => check.started ? accountLabels[check.accountType] ?? '未确认' : '未进行';
    const { first, reconnect, verified } = results.existingLogin;
    console.log('已有登录：首次 ' + status(first) + '，重连 ' + status(reconnect) + '，已提交 0 张。');
    return !results.error && verified;
  }
  if (loginCheck) {
    const ok = !cancellation.signal.aborted && !results.error && results.preflight.ready;
    console.log((ok ? '临时登录预检通过' : '临时登录预检未通过') + '，已提交 0 张。');
    return ok;
  }
  if (results.existingLogin) {
    const { first, reconnect } = results.existingLogin;
    console.log('已有登录：首次 ' + (first.accountType ?? '未确认') + '，重连 ' + (reconnect.accountType ?? '未确认') + '。');
  }
  const handshakeStatus = results.preflight.handshake ? '完成' : activeCheck ? '未完成' : '未开始';
  console.log('握手 ' + handshakeStatus + '，生成预检 ' +
    (results.preflight.ready ? '就绪' : '未就绪') + '，已提交 ' + results.records.filter(r => r.attempted).length + ' 张');
  if (!results.error && !results.preflight.ready) console.error(Object.values(results.preflight.issues).join(' '));
  if (mode.count === 1) {
    const record = results.records[0];
    if (record?.status === 'success') {
      console.log('首图已生成。对比页 ' + path.join(outputDir, 'comparison.html'));
      if (record.referenceHashMatched === null) console.log('此版本未返回参考图指纹，请在对比页核对原画的主体和构图。');
    } else if (record?.outputImage) console.error(record.error);
    else if (record?.error && !results.error) console.error('首图未生成。' + record.error);
  }
  return !cancellation.signal.aborted && !results.error && results.preflight.ready &&
    (!mode.count || results.records.every(r => r.status === 'success'));
}

if (require.main === module) {
  Promise.resolve().then(() => run(modeFrom(process.argv.slice(2))))
    .then(ok => { process.exitCode = ok ? 0 : 1; })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { INSTRUCTION, modeFrom, preflight, runTurn };
