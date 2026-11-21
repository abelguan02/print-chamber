'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { temporaryLoginEnvironment, loginInTerminal } = require('./login-check.cjs');

async function tempDir(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-login-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function fakeCli(root, source) {
  const cli = path.join(root, 'mock-cli');
  await fs.writeFile(cli, '#!' + process.execPath + '\n' + source, { mode: 0o700 });
  return cli;
}

test('the login and preflight share a new private file-based ChatGPT profile', async t => {
  const root = await tempDir(t);
  const base = { PATH: '/usr/bin:/bin', HOME: '/unused-home', CODEX_HOME: '/unused-profile' };
  const env = await temporaryLoginEnvironment(root, base);
  assert.equal(env.HOME, path.join(root, 'home'));
  assert.equal(env.CODEX_HOME, path.join(root, 'profile'));
  assert.equal(env.TMPDIR, path.join(root, 'tmp'));
  assert.equal(env.PATH.split(path.delimiter)[0],
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS');
  assert.equal(base.CODEX_HOME, '/unused-profile');
  for (const dir of [env.HOME, env.CODEX_HOME, env.TMPDIR]) {
    assert.equal((await fs.stat(dir)).isDirectory(), true);
  }
  const config = await fs.readFile(path.join(env.CODEX_HOME, 'config.toml'), 'utf8');
  assert.match(config, /^cli_auth_credentials_store\s*=\s*"file"\s*$/m);
  assert.match(config, /^forced_login_method\s*=\s*"chatgpt"\s*$/m);
});

test('the fake login owns its terminal input and both output streams', async t => {
  const root = await tempDir(t);
  const cli = await fakeCli(root, `
    const fs = require('node:fs');
    if (process.argv[2] !== 'login') process.exit(5);
    process.stdout.write('public-stdout ' + fs.readFileSync(0, 'utf8'));
    process.stderr.write('public-stderr');
  `);
  const entry = require.resolve('./login-check.cjs');
  const script = `
    require(process.argv[1]).loginInTerminal(process.argv[2], process.cwd(), { PATH: '/usr/bin:/bin' },
      new AbortController().signal).catch(() => { process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', script, entry, cli], {
    cwd: root, env: { PATH: '/usr/bin:/bin' }, input: 'fixture-input', encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'public-stdout fixture-input');
  assert.equal(result.stderr, 'public-stderr');
});

test('a failed login rejects before preflight', async t => {
  const root = await tempDir(t);
  const cli = await fakeCli(root, 'process.exit(13);');
  await assert.rejects(loginInTerminal(cli, root, { PATH: '/usr/bin:/bin' }, new AbortController().signal));
});

test('cancelling login waits until the owned process has exited', async t => {
  const root = await tempDir(t);
  const cli = await fakeCli(root, `
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 80));
    require('node:fs').writeFileSync('pid', String(process.pid));
    setTimeout(() => process.exit(0), 4000);
  `);
  const controller = new AbortController();
  const login = loginInTerminal(cli, root, { PATH: '/usr/bin:/bin' }, controller.signal);
  let pid;
  try {
    for (let tries = 0; tries < 150; tries++) {
      try {
        pid = Number(await fs.readFile(path.join(root, 'pid'), 'utf8'));
        if (pid > 0) break;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await delay(10);
    }
  } finally { controller.abort(); }
  await assert.rejects(login);
  assert.ok(pid > 0, 'fixture process should have been running before cancellation');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('the login-check entry point handshakes around login, skips turns, then deletes its profile', async t => {
  const root = await tempDir(t);
  const dir = path.join(root, 'experiments', 'codex-imagegen');
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(path.join(__dirname, 'run.cjs'), path.join(dir, 'run.cjs'));
  for (const name of ['client.cjs', 'login-check.cjs', 'report.cjs', 'image.cjs']) {
    await fs.symlink(path.join(__dirname, name), path.join(dir, name));
  }
  const trace = path.join(root, 'calls');
  const cli = await fakeCli(root, `
    const fs = require('node:fs');
    const trace = name => fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify([name, process.env.CODEX_HOME]) + '\\n');
    const cmd = process.argv[2];
    trace(cmd);
    if (cmd === '--version') console.log('fixture 1');
    else if (cmd === 'login') fs.writeFileSync(process.env.CODEX_HOME + '/public-fixture-marker', 'yes');
    else if (cmd === 'app-server') {
      const reply = {
        initialize: {}, 'account/read': {account: fs.existsSync(process.env.CODEX_HOME + '/public-fixture-marker') ? {type:'chatgpt'} : null},
        'experimentalFeature/list': {data:[{name:'image_generation',enabled:true}]},
        'model/list': {data:[{model:'fixture',inputModalities:['image']}]}, 'account/rateLimits/read': {},
      };
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const {id, method} = JSON.parse(line);
        trace(method);
        if (method === 'initialized') return;
        if (!Object.hasOwn(reply, method)) process.exit(9);
        console.log(JSON.stringify({id, result:reply[method]}));
      });
    } else process.exit(8);
  `);
  await fs.symlink(cli, path.join(root, 'codex'));
  await fs.writeFile(path.join(dir, 'isolation.cjs'), `
    exports.cliOnPath = async () => ${JSON.stringify(cli)};
    exports.isolateGeneration = async (_root, env) => ({...env, PATH: ${JSON.stringify(root)}});
  `);
  const tty = path.join(root, 'fixture-tty.cjs');
  await fs.writeFile(tty, 'process.stdin.isTTY = process.stdout.isTTY = true;');
  const run = spawnSync(process.execPath, ['--require', tty, path.join(dir, 'run.cjs'), '--login-check'], {
    cwd: root, env: { TMPDIR: root, PATH: root }, timeout: 10000, encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const calls = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  const methods = calls.map(([method]) => method);
  assert.deepEqual(methods.filter(m => m === 'initialize' || m === 'login'), ['initialize', 'login', 'initialize']);
  assert.ok(!methods.some(m => /^(thread|turn)\//.test(m)));
  const profile = calls[0][1];
  assert.ok(calls.every(([, home]) => home === profile));
  assert.equal(path.dirname(path.dirname(profile)), await fs.realpath(root));
  await assert.rejects(fs.stat(path.dirname(profile)), { code: 'ENOENT' });
  const [reportDir] = await fs.readdir(path.join(root, 'output'));
  const report = JSON.parse(await fs.readFile(path.join(root, 'output', reportDir, 'results.json'), 'utf8'));
  assert.deepEqual(report.loginCheck, { startupVerified: true, loginCompleted: true });
  assert.equal(report.preflight.ready, true);
  assert.equal(report.requestedSamples, 0);
  assert.deepEqual(report.records, []);
});
