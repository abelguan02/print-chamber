'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const vm = require('node:vm');
const { INSTRUCTION, modeFrom, preflight, runTurn } = require('./run.cjs');
const { writeReport } = require('./report.cjs');

test('default is dry and ambiguous or out-of-range options fail before launching', () => {
  assert.deepEqual(modeFrom([]), modeFrom(['--dry-run']));
  assert.deepEqual(modeFrom(['--check-existing-login']), { name: 'check-existing-login', count: 0 });
  for (const other of ['--limit', '--all', '--login-check', '--dry-run']) {
    assert.throws(() => modeFrom(['--check-existing-login', other]));
  }
  assert.deepEqual(modeFrom(['--limit', '1']), { name: 'limit', count: 1 });
  assert.deepEqual(modeFrom(['--check-image-capability']), { name: 'check-image-capability', count: 0 });
  for (const extra of [['--all'], ['--limit', '1'], ['--dry-run'], ['--check-existing-login'], ['--login-check']]) {
    assert.throws(() => modeFrom(['--check-image-capability', ...extra]));
  }
  assert.deepEqual(modeFrom(['--login-check']), { name: 'login-check', count: 0 });
  assert.deepEqual(modeFrom(['--login-first-image']), { name: 'login-first-image', count: 1 });
  assert.deepEqual(modeFrom(['--first-image-once']), { name: 'first-image-once', count: 1 });
  assert.throws(() => modeFrom(['--first-image-once', '--all']));
  for (const args of [['--login-first-image', '--all'], ['--login-first-image', '--limit', '2'], ['--login-check', '--limit', '1'], ['--login-check', '--all'], ['--limit', '0'], ['--limit', '6'], ['--all', '--dry-run'], ['--limit']]) {
    assert.throws(() => modeFrom(args));
  }
});

test('dry probes stop before thread creation, paginate and omit account metadata', async () => {
  const methods = [];
  let ordinaryUsageAllowed = true;
  let providerSupport = true;
  const rpc = {
    notify: method => methods.push(method),
    async request(method, params) {
      methods.push(method);
      switch (method) {
        case 'initialize': return {};
        case 'account/read': return { account: { type: 'chatgpt', email: 'unneeded@example.invalid' } };
        case 'account/rateLimits/read': return { accountId: 'unneeded', ordinaryUsageAllowed, rateLimits: { primary: { usedPercent: 20 } } };
        case 'experimentalFeature/list': return params.cursor ? { data: [{ name: 'image_generation', enabled: true }] } :
          { data: [], nextCursor: 'next' };
        case 'modelProvider/capabilities/read':
          if (providerSupport === null) throw new Error('capability unavailable');
          return { imageGeneration: providerSupport, webSearch: true };
        case 'model/list': return { data: [{ model: 'sample', isDefault: true, inputModalities: ['image'] }] };
        default: assert.fail(method);
      }
    },
  };
  const checks = { issues: {} };
  await preflight(rpc, checks, {});
  assert.deepEqual(methods.slice(0, 2), ['initialize', 'initialized']);
  assert.equal(checks.ready, true);
  assert.equal(checks.model, 'sample');
  assert.ok(!JSON.stringify(checks).includes('unneeded'));
  for (const supported of [false, null]) {
    providerSupport = supported;
    const blocked = { issues: {} };
    await preflight(rpc, blocked, {});
    assert.equal(blocked.ready, false);
    assert.ok(blocked.issues.providerImageGeneration);
    assert.equal(blocked.imageGeneration, true);
  }
  assert.ok(!methods.includes('turn/start'));
  providerSupport = true;
  ordinaryUsageAllowed = false;
  await preflight(rpc, checks, {});
  assert.equal(checks.ready, false);
});

async function turnFixture(t, handler, timeoutMs, directImage = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-rpc-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, 'out');
  await fs.mkdir(outputDir);
  const record = { id: 1, reply: '', attempted: false, firstEventMs: null, sourceImage: '1-original.png' };
  const calls = [];
  let notify;
  const client = {
    disconnected: new Promise(() => {}),
    async request(method, params) {
      calls.push(method);
      if (method === 'thread/start') {
        assert.equal(params.approvalPolicy, 'never');
        assert.equal(params.sandbox, 'read-only');
        return { thread: { id: 'T' }, sandbox: { type: 'readOnly' }, approvalPolicy: 'never', modelProvider: 'openai' };
      }
      return handler(method, params, notify, outputDir);
    },
    async close() { calls.push('close'); },
  };
  const promise = runTurn({
    client, listen: cb => { notify = cb; }, record, source: { id: 1, sha256: 'b'.repeat(64) },
    prompt: ' G3\n', model: 'sample', tempRoot: root, cwd: root, outputDir, timeoutMs, directImage,
  });
  return { record, calls, outputDir, promise };
}

const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGNkYPjLAAMsDEgAABcjAQPGhqsAAAAAAElFTkSuQmCC';

test('a reference, an image event, real pixels and a matching turn produce a portable report', {
  skip: process.platform !== 'darwin',
}, async t => {
  const { record, calls, outputDir, promise } = await turnFixture(t, (method, params, notify, dir) => {
    assert.equal(method, 'turn/start');
    assert.equal(params.input[0].text, INSTRUCTION + '\n\n G3\n');
    assert.deepEqual(params.input[1], { type: 'localImage', path: path.join(dir, '1-original.png') });
    const notifyItem = item => notify('item/completed', { threadId: 'T', turnId: 'U', item });
    notifyItem({ type: 'agentMessage', text: '图'.repeat(600) });
    notifyItem({ type: 'imageGeneration', status: 'completed', inputImages: [{ sha256: 'b'.repeat(64) }],
      result: tinyPng });
    notify('turn/completed', { threadId: 'T', turn: { id: 'U', status: 'completed' } });
    return { turn: { id: 'U' } };
  });
  await promise;
  assert.deepEqual(calls, ['thread/start', 'turn/start']);
  assert.equal(record.reply.length, 500);
  assert.equal(record.status, 'success');
  assert.equal(record.referenceHashMatched, true);
  assert.deepEqual([record.width, record.height], [4, 2]);
  await writeReport(outputDir, { mode: 'limit', records: [record] });
  const results = JSON.parse(await fs.readFile(path.join(outputDir, 'results.json')));
  assert.equal(results.findings.length, 7);
  assert.equal(results.findings[1].produced, 1);
  assert.match(await fs.readFile(path.join(outputDir, 'comparison.html'), 'utf8'), /1-codex\.png/);
});

test('direct Codex printing accepts the first tool completion without another model turn', {skip: process.platform !== 'darwin'}, async t => {
  const {record,promise,calls}=await turnFixture(t,(_method,params,notify)=>{
    const [text,image]=params.input;
    assert.ok(text.text.includes(JSON.stringify([image.path])));
    assert.ok(text.text.endsWith(' G3\n'));
    notify('item/completed',{threadId:'T',turnId:'U',item:{
      id:'image-1',type:'imageGeneration',status:'completed',result:tinyPng,inputImages:[{sha256:'b'.repeat(64)}],
    }});
    return {turn:{id:'U'}};
  },5000,true);
  await promise;
  assert.equal(record.status,'success');
  assert.deepEqual(calls,['thread/start','turn/start']);
});

test('a generated image with a different input hash fails the source check', {
  skip: process.platform !== 'darwin',
}, async t => {
  const { record, promise } = await turnFixture(t, (_method, _params, notify) => {
    notify('item/completed', { threadId: 'T', turnId: 'U', item: {
      type: 'imageGeneration', status: 'completed', inputImages: [{ sha256: 'c'.repeat(64) }], result: tinyPng,
    } });
    notify('turn/completed', { threadId: 'T', turn: { id: 'U', status: 'completed' } });
    return { turn: { id: 'U' } };
  });
  await assert.rejects(promise, /输入与第 1 张原画不符/);
  assert.equal(record.referenceHashMatched, false);
  assert.equal(record.outputImage, '1-codex.png');
});

test('text-only completion never counts an image; foreign notifications are ignored', async t => {
  const { record, promise } = await turnFixture(t, (_m, _p, notify) => {
    notify('item/started', { threadId: 'other', turnId: 'U', item: { type: 'imageGeneration' } });
    notify('item/completed', { threadId: 'T', turnId: 'U', item: { type: 'agentMessage', text: 'done' } });
    notify('turn/completed', { threadId: 'T', turn: { id: 'U', status: 'completed' } });
    return { turn: { id: 'U' } };
  });
  await assert.rejects(promise, /有效输出/);
  assert.equal(record.reply, 'done');
  assert.ok(!record.imageToolCalled);
});

test('a tool failure reported only in the final turn items is counted and keeps its error code', async t => {
  const { record, promise } = await turnFixture(t, (_method, _params, notify) => {
    notify('turn/completed', { threadId: 'T', turn: { id: 'U', status: 'completed', items: [{
      type: 'imageGeneration', id: 'I', status: 'failed', result: '', failure: { type: 'usageLimitExceeded' },
    }] } });
    return { turn: { id: 'U' } };
  });
  await assert.rejects(promise, /图片工具未成功完成/);
  assert.equal(record.terminalItemsView, 'full');
  assert.equal(record.imageToolCalled, true);
  assert.equal(record.imageToolCallCount, 1);
  assert.equal(record.imageToolFailure, 'usageLimitExceeded');
  assert.equal(record.imageToolStatus, 'failed');
});

test('final items can deliver an image and preserve streamed bytes when the final copy is sparse', {
  skip: process.platform !== 'darwin',
}, async t => {
  const item = { type: 'imageGeneration', id: 'I', status: 'completed', result: tinyPng,
    inputImages: [{ path: '/fixture.png', sha256: 'b'.repeat(64) }] };
  for (const view of ['terminal-only', 'full', 'summary', 'notLoaded']) {
    const { record, outputDir, promise } = await turnFixture(t, (_method, _params, notify) => {
      const turn = { id: 'U', status: 'completed', itemsView: 'full', items: [item] };
      if (view !== 'terminal-only') {
        notify('item/started', { threadId: 'T', turnId: 'U', item: { ...item, status: 'inProgress', result: '' } });
        notify('item/completed', { threadId: 'T', turnId: 'U', item });
        turn.itemsView = view;
        turn.items = view === 'notLoaded' ? [] : [{ type: 'imageGeneration', id: 'I',
          status: 'completed', fileId: 'fixture-file-id', result: '', savedPath: null, inputImages: [] }];
      }
      notify('turn/completed', { threadId: 'T', turn });
      return { turn: { id: 'U' } };
    });
    await promise;
    assert.equal(record.status, 'success');
    assert.equal(record.imageToolCallCount, 1);
    assert.equal(record.referenceHashMatched, true);
    assert.deepEqual(await fs.readdir(outputDir), ['1-codex.png']);
    assert.deepEqual([record.width, record.height], [4, 2]);
  }
});

test('incomplete final item lists are identified and another turn cannot supply a tool result', async t => {
  for (const view of ['unknown', 'notLoaded', 'summary', 'full']) {
    const { record, promise } = await turnFixture(t, (_method, _params, notify) => {
      notify('turn/started', { threadId: 'T', turn: { id: 'U', status: 'inProgress' } });
      notify('turn/completed', { threadId: 'T', turn: { id: 'other', status: 'completed', items: [{
        type: 'imageGeneration', id: 'I', status: 'completed', result: tinyPng,
      }] } });
      const turn = { id: 'U', status: 'completed' };
      if (view !== 'unknown') Object.assign(turn, { items: [], itemsView: view });
      notify('turn/completed', { threadId: 'T', turn });
      return { turn: { id: 'U' } };
    });
    await assert.rejects(promise, error => {
      assert.match(error.message, /未观测到图片生成工具调用/);
      assert.equal(error.message.includes('完整条目'), view !== 'full');
      return true;
    });
    assert.equal(record.terminalItemsView, view);
    assert.ok(!record.imageToolCalled);
  }
});

test('deadline interrupts only the owned turn and awaits its terminal notification', async t => {
  const { calls, record, promise } = await turnFixture(t, (method, params, notify) => {
    if (method === 'turn/start') return { turn: { id: 'U' } };
    assert.equal(method, 'turn/interrupt');
    assert.deepEqual(params, { threadId: 'T', turnId: 'U' });
    notify('turn/completed', { threadId: 'T', turn: { id: 'U', status: 'interrupted' } });
    return {};
  }, 20);
  await assert.rejects(promise, /超过/);
  assert.deepEqual(calls, ['thread/start', 'turn/start', 'turn/interrupt']);
  assert.equal(record.turnStatus, 'interrupted');
});

test('the default dry run stops before handshake when the generation launcher is unavailable', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-dry-isolation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'experiments', 'codex-imagegen');
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(path.join(__dirname, 'run.cjs'), path.join(dir, 'run.cjs'));
  for (const file of ['image.cjs', 'client.cjs', 'report.cjs', 'login-check.cjs']) {
    await fs.symlink(path.join(__dirname, file), path.join(dir, file));
  }
  await fs.writeFile(path.join(dir, 'desktop-cli.cjs'), 'exports.findDesktopCli = async () => process.execPath;');
  await fs.writeFile(path.join(dir, 'isolation.cjs'), `
    exports.isolateGeneration = async () => { throw new Error('mock isolation refused'); };
  `);
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [path.join(dir, 'run.cjs')], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: root, HOME: root, TMPDIR: root, PRINT_CHAMBER_G3_DIR: root },
  });
  assert.equal(result.status, 1);
  const [runDir] = await fs.readdir(path.join(root, 'output'));
  const report = JSON.parse(await fs.readFile(path.join(root, 'output', runDir, 'results.json')));
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.environment.codexExecutable, process.execPath);
  assert.equal(report.environment.codexSource, 'chatgpt-desktop-bundle');
  assert.equal(report.error, 'mock isolation refused');
  assert.equal(report.preflight.ready, false);
  assert.equal(report.preflight.handshake, false);
  assert.ok(!report.serverPid);
  assert.deepEqual(report.records, []);
});

async function runProbeFixture(t, {
  accounts, flag, providerSupport = true, inputModalities = ['image'], ordinaryUsageAllowed = null,
  rateLimits = {}, rateLimitsByLimitId = null, spendLimitBeforeTurn = false, imageToolCalled = true,
}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-session-reuse-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'experiments', 'codex-imagegen');
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(path.join(__dirname, 'run.cjs'), path.join(dir, 'run.cjs'));
  for (const file of ['image.cjs', 'client.cjs', 'login-check.cjs']) {
    await fs.symlink(path.join(__dirname, file), path.join(dir, file));
  }
  const cli = path.join(root, 'codex');
  const trace = path.join(root, 'methods');
  await fs.writeFile(trace, '');
  const singleImage = flag === '--first-image-once';
  let prompt, sourceHash;
  if (singleImage) {
    const dataset = path.join(root, 'output', 'scenes-g3-20261025-060950');
    await fs.mkdir(dataset, { recursive: true });
    const context = {};
    vm.runInNewContext(await fs.readFile(path.join(__dirname, '../../extension/cloud-prompt.js'), 'utf8'), context);
    prompt = context.CLOUD_PROMPT;
    const pixels = await fs.readFile(path.join(__dirname, '../../tests/fixtures/artwork.png'));
    sourceHash = createHash('sha256').update(pixels).digest('hex');
    const sources = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1, path: path.join(root, `sample-${i + 1}.png`), sha256: sourceHash,
    }));
    // Only the authorized sample has files. Any attempt to load another will fail.
    await Promise.all([
      fs.writeFile(path.join(dataset, 'prompt.txt'), prompt),
      fs.writeFile(path.join(dataset, 'metrics.json'), JSON.stringify({ sources })),
      fs.writeFile(sources[0].path, pixels),
      fs.writeFile(path.join(dataset, '1-G3.png'), pixels),
    ]);
  }
  if (flag && !singleImage) {
    await fs.writeFile(path.join(dir, 'report.cjs'), `
      exports.loadDataset = async () => { require('node:fs').appendFileSync(${JSON.stringify(trace)}, '{"method":"dataset"}\\n'); };
    `);
  } else {
    await fs.symlink(path.join(__dirname, 'report.cjs'), path.join(dir, 'report.cjs'));
  }
  await fs.writeFile(cli, '#!' + process.execPath + '\n' + `
    const fs = require('node:fs');
    const file = ${JSON.stringify(trace)};
    const log = entry => fs.appendFileSync(file, JSON.stringify(entry) + '\\n');
    const command = process.argv[2];
    if (command === '--version') console.log('codex-cli 0.171.0-alpha.13');
    else if (command === 'app-server') {
      const previous = fs.readFileSync(file, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse);
      const type = ${JSON.stringify(accounts)}[previous.filter(r => r.method === 'start').length];
      const methods = {
        initialize: {}, 'account/read': {account: type ? {type:type === 'cancel' ? 'chatgpt' : type, email:'unused@example.invalid'} : null},
        'experimentalFeature/list': {data:[{name:'image_generation',enabled:true}]},
        'modelProvider/capabilities/read': {imageGeneration:${JSON.stringify(providerSupport)}},
        'model/list': {data:[{model:'fixture', inputModalities:${JSON.stringify(inputModalities)}}]},
        'account/rateLimits/read': ${JSON.stringify({
          ordinaryUsageAllowed, rateLimits, rateLimitsByLimitId, accountId: 'unused@example.invalid',
        })},
      };
      let limitsRead = 0;
      log({method:'start', profile:process.env.CODEX_HOME, cwd:process.cwd(), args:process.argv.slice(2)});
      process.on('exit', () => {
        log({method:'end'});
        if (type === 'cancel') process.kill(process.ppid, 'SIGTERM');
      });
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const {id, method, params} = JSON.parse(line);
        if (method === 'thread/start') {
          log({method, model:params.model, sandbox:params.sandbox, approvalPolicy:params.approvalPolicy, ephemeral:params.ephemeral});
          console.log(JSON.stringify({id, result:{thread:{id:'T'}, model:params.model, modelProvider:'openai',
            approvalPolicy:'never', sandbox:{type:'readOnly', networkAccess:false}}}));
          return;
        }
        if (method === 'turn/start') {
          const reference = params.input.find(item => item.type === 'localImage');
          const sha256 = require('node:crypto').createHash('sha256').update(fs.readFileSync(reference.path)).digest('hex');
          log({method, sha256, attachedFromWork:require('node:path').dirname(reference.path) === process.cwd(),
            inputTypes:params.input.map(item => item.type), text:params.input.find(item => item.type === 'text').text});
          console.log(JSON.stringify({id, result:{turn:{id:'U'}}}));
          const send = (method, params) => console.log(JSON.stringify({method, params}));
          if (${JSON.stringify(imageToolCalled)}) {
            const savedPath = require('node:path').join(process.cwd(), 'generated.png');
            fs.writeFileSync(savedPath, Buffer.from(${JSON.stringify(tinyPng)}, 'base64'));
            send('item/completed', {threadId:'T', turnId:'U', item:{
              type:'imageGeneration', id:'I', status:'completed', generationId:'G', savedPath, inputImages:[{path:reference.path, sha256}],
            }});
          }
          send('turn/completed', {threadId:'T', turn:{id:'U', status:'completed'}});
          return;
        }
        log({method});
        if (method === 'initialized') return;
        if (!Object.hasOwn(methods, method)) process.exit(8);
        if (method === 'account/read' && (params.refreshToken !== false || Object.keys(params).length !== 1)) process.exit(9);
        if (method === 'account/read' && type === 'disconnect') process.exit(3);
        if (method === 'account/rateLimits/read' && ++limitsRead === 2 && ${JSON.stringify(spendLimitBeforeTurn)}) {
          methods[method].rateLimitsByLimitId = {codex:{limitId:'codex', spendControlReached:true}};
        }
        console.log(JSON.stringify({id, result:methods[method]}));
      });
    } else { log({method:command}); process.exit(7); }
  `, { mode: 0o700 });
  await fs.writeFile(path.join(dir, 'desktop-cli.cjs'), `exports.findDesktopCli = async () => ${JSON.stringify(cli)};`);
  const launcher = singleImage ? 'isolateDesktopImage' : flag ? 'isolateLoginCheck' : 'isolateGeneration';
  await fs.writeFile(path.join(dir, 'isolation.cjs'), `
    exports.${launcher} = async (_root, env, cli) => {
      if (cli !== ${JSON.stringify(cli)}) throw new Error('unexpected executable');
      return env;
    };
  `);
  const profile = path.join(root, 'existing-user');
  const flags = flag ? [flag] : [];
  const invoke = () => require('node:child_process').spawnSync(process.execPath, [path.join(dir, 'run.cjs'), ...flags], {
    cwd: root, encoding: 'utf8', timeout: 8000,
    env: { PATH: root, HOME: root, CODEX_HOME: profile, TMPDIR: root, PRINT_CHAMBER_G3_DIR: root },
  });
  const result = invoke();
  const outputDir = result.stdout.match(/^报告 (.+)$/m)?.[1];
  assert.ok(outputDir, result.stderr || result.stdout);
  const report = JSON.parse(await fs.readFile(path.join(outputDir, 'results.json')));
  const readTrace = async () => (await fs.readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const entries = await readTrace();
  return { result, report, entries, profile, cli, outputDir, invoke, readTrace, prompt, sourceHash };
}

test('one desktop image authorization submits only the first verified reference, then stays consumed', {
  skip: process.platform !== 'darwin',
}, async t => {
  const fixture = await runProbeFixture(t, {
    accounts: ['chatgpt', 'chatgpt'], flag: '--first-image-once', ordinaryUsageAllowed: true,
  });
  const { result, report, entries, profile, invoke, readTrace, prompt, sourceHash } = fixture;
  assert.equal(result.status, 0, result.stderr);
  const starts = entries.filter(e => e.method === 'start');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].profile, profile);
  assert.deepEqual(starts[0], starts[1]);
  assert.equal(report.existingLogin.verified, true);
  assert.deepEqual(entries.filter(e => e.method === 'thread/start'), [{
    method: 'thread/start', model: 'fixture', sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true,
  }]);
  assert.deepEqual(entries.filter(e => e.method === 'turn/start'), [{
    method: 'turn/start', sha256: sourceHash, attachedFromWork: true,
    inputTypes: ['text', 'localImage'], text: INSTRUCTION + '\n\n' + prompt,
  }]);
  assert.equal(report.records.length, 1);
  assert.equal(report.records[0].id, 1);
  assert.equal(report.records[0].status, 'success');
  assert.equal(report.records[0].referenceHashMatched, true);
  assert.deepEqual([report.records[0].width, report.records[0].height], [4, 2]);
  assert.equal(invoke().status, 1);
  assert.deepEqual(await readTrace(), entries);
});

test('login and quota failures consume the one-shot authorization without starting a turn', async t => {
  const cases = [
    { accounts: ['chatgpt', null] },
    { ordinaryUsageAllowed: null },
    { rateLimitsByLimitId: { codex: { limitId: 'codex', rateLimitReachedType: 'rate_limit_reached' } } },
    { spendLimitBeforeTurn: true },
  ];
  for (const scenario of cases) {
    const { result, entries, report, invoke, readTrace } = await runProbeFixture(t, {
      accounts: ['chatgpt', 'chatgpt'], flag: '--first-image-once', ordinaryUsageAllowed: true, ...scenario,
    });
    assert.equal(result.status, 1, result.stdout);
    assert.equal(entries.filter(e => e.method === 'start').length, 2);
    assert.ok(!entries.some(e => ['login', 'thread/start', 'turn/start'].includes(e.method)));
    assert.equal(report.records[0].attempted, false);
    assert.ok(report.records[0].error);
    assert.equal(invoke().status, 1);
    assert.deepEqual(await readTrace(), entries);
  }
});

test('a completed desktop turn with no image consumes the authorization and cannot submit again', async t => {
  const { result, entries, report, invoke, readTrace } = await runProbeFixture(t, {
    accounts: ['chatgpt', 'chatgpt'], flag: '--first-image-once', ordinaryUsageAllowed: true, imageToolCalled: false,
  });
  assert.equal(result.status, 1, result.stdout);
  assert.equal(entries.filter(e => e.method === 'turn/start').length, 1);
  assert.equal(report.records[0].attempted, true);
  assert.equal(report.records[0].status, 'failed');
  assert.equal(report.records[0].outputImage, null);
  assert.equal(invoke().status, 1);
  assert.deepEqual(await readTrace(), entries);
});

test('daily sessions reconnect to the same profile and stop immediately if either connection lacks a login', async t => {
  const normalCases = [['chatgpt', 'chatgpt'], ['chatgpt', null], [null]];
  const testCases = [
    ...normalCases.map(accounts => ({ accounts, loginOnly: false })),
    ...[...normalCases, ['apiKey'], ['chatgpt', 'disconnect'], ['cancel']].map(accounts => ({ accounts, loginOnly: true })),
  ];
  for (const { accounts, loginOnly } of testCases) {
    const { result, report, entries, profile, cli, outputDir } = await runProbeFixture(t, {
      accounts, flag: loginOnly ? '--check-existing-login' : null,
    });
    const verified = accounts.length === 2 && accounts[1] === 'chatgpt';
    assert.equal(result.status, verified ? 0 : 1, result.stderr);
    assert.equal(report.environment.codexSource, 'chatgpt-desktop-bundle');
    assert.equal(report.existingLogin.verified, verified);
    assert.equal(report.existingLogin.first.accountType, accounts[0] === 'cancel' ? 'chatgpt' : accounts[0] ?? 'signed-out');
    const reconnectType = accounts.length === 2 && accounts[1] !== 'disconnect' ? accounts[1] ?? 'signed-out' : null;
    assert.equal(report.existingLogin.reconnect.accountType, reconnectType);
    if (loginOnly) {
      assert.equal(report.existingLogin.first.started, true);
      assert.equal(report.existingLogin.reconnect.started, accounts.length === 2);
      assert.equal(report.submitted, 0);
      assert.equal(report.preflight, undefined);
      assert.equal(report.records, undefined);
      assert.deepEqual(await fs.readdir(outputDir), ['results.json']);
      if (accounts.length === 1) assert.match(result.stdout, /重连 未进行/);
    } else {
      assert.equal(report.environment.codexExecutable, cli);
      assert.equal(report.preflight.ready, verified);
      assert.deepEqual(report.records, []);
    }
    const starts = entries.filter(e => e.method === 'start');
    assert.equal(starts.length, accounts.length);
    assert.equal(starts[0].profile, profile);
    if (accounts.length === 2) assert.deepEqual(starts[0], starts[1]);
    const methods = entries.map(e => e.method);
    const handshake = ['start', 'initialize', 'initialized', 'account/read'];
    const expected = [...handshake, 'end'];
    if (accounts.length === 2) expected.push(...handshake);
    if (verified && !loginOnly) expected.push('experimentalFeature/list', 'modelProvider/capabilities/read', 'model/list', 'account/rateLimits/read');
    if (accounts.length === 2) expected.push('end');
    assert.deepEqual(methods, expected);
    assert.ok(!JSON.stringify(report).includes('unused@example.invalid'));
  }
});

test('the image capability check inspects four conditions in one existing-login connection and submits nothing', async t => {
  const reached = { limitId: 'codex', rateLimitReachedType: 'rate_limit_reached' };
  const cases = [
    { account: 'chatgpt', ordinaryUsageAllowed: true, ready: true, quotaStatus: 'allowed' },
    { account: 'chatgpt', ordinaryUsageAllowed: null, ready: true, quotaStatus: 'unknown' },
    { account: 'chatgpt', ordinaryUsageAllowed: false, ready: false, quotaStatus: 'blocked' },
    { account: 'chatgpt', rateLimitsByLimitId: { codex: reached }, ready: false, quotaStatus: 'unknown',
      codexLimitReason: 'rate_limit_reached' },
    { account: 'chatgpt', rateLimits: reached, ready: false, quotaStatus: 'unknown',
      codexLimitReason: 'rate_limit_reached' },
    { account: 'chatgpt', rateLimitsByLimitId: { unrelated: { ...reached, limitId: 'unrelated' } },
      ready: true, quotaStatus: 'unknown' },
    { account: 'chatgpt', providerSupport: false, ready: false, quotaStatus: 'unknown' },
    { account: 'chatgpt', inputModalities: ['text'], ready: false, quotaStatus: 'unknown' },
    { account: null, ready: false, quotaStatus: 'unknown' },
  ];
  for (const scenario of cases) {
    const { result, report, entries, profile, outputDir } = await runProbeFixture(t, {
      accounts: [scenario.account], flag: '--check-image-capability', ...scenario,
    });
    assert.equal(result.status, scenario.ready ? 0 : 1, result.stderr);
    assert.match(path.basename(outputDir), /^codex-image-capability-/);
    assert.deepEqual(await fs.readdir(outputDir), ['results.json']);
    assert.equal(report.mode, 'check-image-capability');
    assert.equal(report.submitted, 0);
    assert.equal(report.environment.codexSource, 'chatgpt-desktop-bundle');
    assert.equal(report.preflight.handshake, true);
    assert.equal(report.preflight.accountType, scenario.account ?? 'signed-out');
    assert.equal(report.preflight.ready, scenario.ready);
    assert.equal(report.preflight.quotaStatus, scenario.quotaStatus);
    assert.equal(report.preflight.codexLimitReason ?? null, scenario.codexLimitReason ?? null);
    assert.equal(entries[0].profile, profile);
    assert.ok(!JSON.stringify(report).includes('unused@example.invalid'));

    const methods = entries.map(entry => entry.method);
    assert.deepEqual(methods.slice(0, 4), ['start', 'initialize', 'initialized', 'account/read']);
    assert.equal(methods.at(-1), 'end');
    const probes = scenario.account ? [
      'experimentalFeature/list', 'modelProvider/capabilities/read', 'model/list', 'account/rateLimits/read',
    ] : [];
    assert.deepEqual(methods.slice(4, -1).sort(), probes.sort());
    if (scenario.account) {
      assert.equal(report.preflight.imageGeneration, true);
      assert.equal(report.preflight.providerImageGeneration, scenario.providerSupport ?? true);
      assert.equal(report.preflight.model, scenario.inputModalities ? null : 'fixture');
    }
  }
});
