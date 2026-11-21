'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AppServerClient } = require('./client.cjs');

// The only executable on the child's PATH is this test's Node interpreter.
async function fakeClient(t, script, onNotification) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-rpc-test-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.symlink(process.execPath, path.join(cwd, 'codex'));
  await fs.writeFile(path.join(cwd, 'app-server'), script);
  const client = new AppServerClient({ cwd, env: { PATH: cwd }, onNotification });
  t.after(() => client.close());
  return client;
}

test('dispatches early events, replies by id and refuses server-initiated requests', async t => {
  const events = [];
  const client = await fakeClient(t, `
    const lines = require('node:readline').createInterface({ input: process.stdin });
    const send = x => console.log(JSON.stringify(x));
    lines.on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') {
        send({method:'early',params:{ok:true}});
        send({id:m.id,method:'item/commandExecution/requestApproval'});
      } else if (m.error?.code === -32601) {
        send({id:m.id,result:'refused'});
      } else if (m.method === 'initialized') {
        send({method:'ready',params:null});
      } else if (m.method === 'check') {
        send({id:m.id,result:'done'});
      }
    });
  `, (method, params) => events.push([method, params]));
  assert.equal(await client.request('initialize', {}), 'refused');
  client.notify('initialized');
  assert.equal(await client.request('check', {}), 'done');
  assert.deepEqual(events, [['early', { ok: true }], ['ready', null]]);
  await client.close();
  assert.throws(() => process.kill(client.pid, 0), { code: 'ESRCH' });
});

test('times out one request and discards private error data', async t => {
  const client = await fakeClient(t, `
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'fail') console.log(JSON.stringify({id:m.id,error:{code:-32004,message:'private detail'}}));
    });
  `);
  await assert.rejects(client.request('noResponse', {}, 25), /noResponse timed out/);
  await assert.rejects(client.request('fail', {}), { message: 'fail failed (RPC -32004)', rpcCode: -32004 });
});

test('startup failure retains the exit code after stdout closes, without relaying stderr', async t => {
  const client = await fakeClient(t, `
    console.error('private diagnostics');
    require('node:fs').closeSync(1);
    setTimeout(() => process.exit(37), 30);
  `);
  await assert.rejects(client.request('initialize', {}), {
    code: 'APP_SERVER_EXITED', exitCode: 37, signal: null, message: 'app-server exited (exit code 37)',
  });
  assert.equal((await client.disconnected).exitCode, 37);
});

test('termination by signal is reported independently of exit status', async t => {
  const client = await fakeClient(t, "process.kill(process.pid, 'SIGTERM')");
  await assert.rejects(client.request('initialize', {}), {
    code: 'APP_SERVER_EXITED', exitCode: null, signal: 'SIGTERM', message: 'app-server exited (signal SIGTERM)',
  });
});

test('a server that closes stdout but keeps running is detected before request timeout', async t => {
  const client = await fakeClient(t, "require('node:fs').closeSync(1); setInterval(() => {}, 500)");
  await assert.rejects(client.request('initialize', {}, 3000), { code: 'APP_SERVER_CHANNEL_CLOSED' });
  await client.close();
  assert.throws(() => process.kill(client.pid, 0), { code: 'ESRCH' });
});

test('unexpected stdout fails closed without returning its contents', async t => {
  const client = await fakeClient(t, "console.log('private diagnostics')");
  await assert.rejects(client.request('initialize', {}), { message: 'Invalid app-server message or notification handler failure' });
});

test('a missing binary settles both request and close', async () => {
  const client = new AppServerClient({ cwd: os.tmpdir(), env: { PATH: '/nonexistent-pc-test' } });
  await assert.rejects(client.request('initialize', {}), /app-server/);
  await client.close();
});

test('close reaps an unresponsive owned child and tolerates repeated cleanup', async t => {
  const client = await fakeClient(t, `
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 500);
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      console.log(JSON.stringify({id:JSON.parse(line).id,result:null}));
    });
  `);
  await client.request('initialize', {});
  const close = client.close();
  assert.equal(client.close(), close);
  await close;
  assert.throws(() => process.kill(client.pid, 0), { code: 'ESRCH' });
});
