'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isolateGeneration, isolateLoginCheck, isolateDesktopImage } = require('./isolation.cjs');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pc-seatbelt-'")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'run');
  const bin = path.join(root, 'bin');
  await fs.mkdir(run);
  await fs.mkdir(bin);
  return { run, bin, root };
}

function skipNestedSandbox(t, error) {
  if (error.code !== 'PROCESS_ISOLATION_UNAVAILABLE') throw error;
  const probe = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']);
  if (!probe.stderr?.toString().includes('Operation not permitted')) throw error;
  t.skip('host denies nested macOS sandbox; preflight failed closed');
}

async function testLauncher(t, launcher, allowStateWrite) {
  const { bin, root, run } = await fixture(t);
  // Use the system shell as the fixture executable. Its builtins can attempt
  // native filesystem writes before testing the separate process-exec rule.
  let verified;
  let env;
  try {
    env = await launcher(run, { PATH: bin }, '/bin/bash', async file => { verified = file; });
  } catch (error) {
    skipNestedSandbox(t, error);
    return;
  }
  assert.equal(verified, '/bin/bash');
  const inside = path.join(run, 'inside');
  const state = path.join(root, 'synthetic-runtime-state');
  const cmd = (source, ...args) => spawnSync('codex', ['-c', source, 'probe', ...args], { env, cwd: run });
  const write = cmd('echo yes > "$1"', inside);
  assert.equal(write.status, 0, write.stderr.toString());
  assert.equal((await fs.readFile(inside, 'utf8')).trim(), 'yes');
  const update = cmd('echo updated > "$1"', state);
  if (allowStateWrite) {
    assert.equal(update.status, 0, update.stderr.toString());
    assert.equal((await fs.readFile(state, 'utf8')).trim(), 'updated');
  } else {
    assert.notEqual(update.status, 0);
    await assert.rejects(fs.access(state), { code: 'ENOENT' });
  }
  assert.notEqual(cmd('exec /usr/bin/true').status, 0);
  assert.equal(cmd('printf %s "$PATH"').stdout.toString(), bin);
}

const macOS = { skip: process.platform !== 'darwin' };
test('generation confines writes to the temporary directory and blocks other commands', macOS,
  t => testLauncher(t, isolateGeneration, false));
test('a login check permits normal runtime state writes and blocks other commands', macOS,
  t => testLauncher(t, isolateLoginCheck, true));

test('desktop generation permits required state maintenance and denies personal image storage', macOS, async t => {
  const { root, bin, run } = await fixture(t);
  const state = path.join(root, 'synthetic-state');
  const generatedImages = path.join(state, 'generated_images');
  await fs.mkdir(generatedImages, { recursive: true });
  let env;
  try {
    env = await isolateDesktopImage(run, { PATH: bin, HOME: root, CODEX_HOME: state }, process.execPath, async () => {});
  } catch (error) {
    skipNestedSandbox(t, error);
    return;
  }
  // A local Node fixture can perform the native operations without starting tools or Codex.
  const probe = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const state = process.env.CODEX_HOME;
    const tmp = path.join(state, 'tmp');
    const arg0 = path.join(tmp, 'arg0-macos');
    const denied = e => ['EPERM', 'EACCES'].includes(e.code);
    fs.writeFileSync(path.join(state, 'installation_id'), 'test');
    fs.mkdirSync(tmp);
    fs.chmodSync(tmp, 0o700);
    fs.mkdirSync(arg0);
    fs.writeFileSync(path.join(arg0, 'fixture'), 'helper');
    fs.writeFileSync('result.png', 'fixture');
    assert.throws(() => fs.writeFileSync(path.join(state, 'generated_images', 'result.png'), 'x'), denied);
    assert.throws(() => fs.writeFileSync(path.join(state, 'extra'), 'x'), denied);
    assert.throws(() => fs.writeFileSync(path.join(tmp, 'extra'), 'x'), denied);
    const other = spawnSync('/usr/bin/true');
    assert.notEqual(other.status, 0);
  `;
  const result = spawnSync('codex', ['-e', probe], { cwd: run, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await fs.readdir(generatedImages), []);
});
