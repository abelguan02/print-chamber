'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { INSTRUCTION, modeFrom, preflight, runTurn } = require('./run.cjs');
const { writeReport } = require('./report.cjs');

test('default is dry and ambiguous or out-of-range options fail before launching', () => {
  assert.deepEqual(modeFrom([]), modeFrom(['--dry-run']));
  assert.deepEqual(modeFrom(['--limit', '1']), { name: 'limit', count: 1 });
  assert.deepEqual(modeFrom(['--login-check']), { name: 'login-check', count: 0 });
  assert.deepEqual(modeFrom(['--login-first-image']), { name: 'login-first-image', count: 1 });
  for (const args of [['--login-first-image', '--all'], ['--login-first-image', '--limit', '2'], ['--login-check', '--limit', '1'], ['--login-check', '--all'], ['--limit', '0'], ['--limit', '6'], ['--all', '--dry-run'], ['--limit']]) {
    assert.throws(() => modeFrom(args));
  }
});

test('dry probes stop before thread creation, paginate and omit account metadata', async () => {
  const methods = [];
  let ordinaryUsageAllowed = true;
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
  ordinaryUsageAllowed = false;
  await preflight(rpc, checks, {});
  assert.equal(checks.ready, false);
});

async function turnFixture(t, handler, timeoutMs) {
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
    prompt: ' G3\n', model: 'sample', tempRoot: root, cwd: root, outputDir, timeoutMs,
  });
  return { record, calls, outputDir, promise };
}

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
      result: 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGNkYPjLAAMsDEgAABcjAQPGhqsAAAAAAElFTkSuQmCC' });
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
  await fs.writeFile(path.join(dir, 'isolation.cjs'), `
    exports.cliOnPath = async () => process.execPath;
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
  assert.equal(report.error, 'mock isolation refused');
  assert.equal(report.preflight.ready, false);
  assert.equal(report.preflight.handshake, false);
  assert.ok(!report.serverPid);
  assert.deepEqual(report.records, []);
});
