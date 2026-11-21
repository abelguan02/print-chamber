'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isolateGeneration } = require('./isolation.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-seatbelt-'"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'run');
  const bin = path.join(root, 'bin');
  await fs.mkdir(run);
  await fs.mkdir(bin);
  return { run, bin, root };
}

test('the launcher allows temporary writes and denies external writes and other commands', {
  skip: process.platform !== 'darwin',
}, async t => {
  const { bin, root, run } = await fixture(t);
  // Use the system shell as the fixture executable. Its builtins can attempt
  // native filesystem writes before testing the separate process-exec rule.
  await fs.symlink('/bin/bash', path.join(bin, 'codex'));
  let env;
  try {
    env = await isolateGeneration(run, { PATH: bin }, '/bin/bash', async () => {});
  } catch (error) {
    if (!error.message.includes('macOS process isolation unavailable')) throw error;
    const probe = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']);
    if (!probe.stderr?.toString().includes('Operation not permitted')) throw error;
    t.skip('host denies nested macOS sandbox; preflight failed closed');
    return;
  }
  const inside = path.join(run, 'inside');
  const outside = path.join(root, 'outside');
  const cmd = (source, ...args) => spawnSync('codex', ['-c', source, 'probe', ...args], { env, cwd: run });
  const write = cmd('echo yes > "$1"', inside);
  assert.equal(write.status, 0, write.stderr.toString());
  assert.equal((await fs.readFile(inside, 'utf8')).trim(), 'yes');
  assert.notEqual(cmd('echo denied > "$1"', outside).status, 0);
  await assert.rejects(fs.access(outside), { code: 'ENOENT' });
  assert.notEqual(cmd('exec /usr/bin/true').status, 0);
  assert.equal(cmd('printf %s "$PATH"').stdout.toString(), bin);
});
