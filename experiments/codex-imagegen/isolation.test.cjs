'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isolateGeneration, isolateLoginCheck } = require('./isolation.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-seatbelt-'"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'run');
  const bin = path.join(root, 'bin');
  await fs.mkdir(run);
  await fs.mkdir(bin);
  return { run, bin, root };
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
    if (error.code !== 'PROCESS_ISOLATION_UNAVAILABLE') throw error;
    const probe = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']);
    if (!probe.stderr?.toString().includes('Operation not permitted')) throw error;
    t.skip('host denies nested macOS sandbox; preflight failed closed');
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
