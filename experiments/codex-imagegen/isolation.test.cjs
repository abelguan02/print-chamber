'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isolateGeneration, cliOnPath, resolveInstallPath } = require('./isolation.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-seatbelt-'"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'run');
  const bin = path.join(root, 'bin');
  await fs.mkdir(run);
  await fs.mkdir(bin);
  return { run, bin, root };
}

test('a protected install link fails before opening its target or picking a different CLI', {
  skip: process.platform !== 'darwin',
}, async t => {
  const { bin, root, run } = await fixture(t);
  await fs.symlink(path.join(os.userInfo().homedir, '.codex', 'never-open-this-fixture'), path.join(bin, 'codex'));
  await fs.symlink('/usr/bin/true', path.join(root, 'codex'));
  await assert.rejects(cliOnPath(bin + ':' + root, run), /private user directory/);
  const privateTools = path.join(os.userInfo().homedir, '.codex', 'never-probe-this-directory');
  assert.equal(await cliOnPath(privateTools + ':' + root, run), await fs.realpath('/usr/bin/true'));
});

test('only the public shortcut may follow current to the native standalone release', async t => {
  const { root } = await fixture(t);
  const home = await fs.realpath(root);
  const bin = path.join(home, '.local', 'bin');
  const packageDir = path.join(home, '.codex', 'packages', 'standalone');
  const release = path.join(packageDir, 'releases', '0.156.1-aarch64-apple-darwin');
  const executable = path.join(release, 'bin', 'codex');
  const launcher = path.join(bin, 'codex');
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, 'fixture');
  const current = path.join(packageDir, 'current');
  await fs.symlink(path.relative(packageDir, release), current);
  await fs.symlink(path.join(current, 'bin', 'codex'), launcher);
  assert.equal(await resolveInstallPath(launcher, home), executable);
  await assert.rejects(resolveInstallPath(executable, home), /private user directory/);
  await fs.unlink(current);
  await fs.symlink('../../unrelated', current);
  await assert.rejects(resolveInstallPath(launcher, home), /private user directory/);
  await fs.unlink(launcher);
  await fs.symlink(path.join(home, '.codex', 'unrelated'), launcher);
  await assert.rejects(resolveInstallPath(launcher, home), /private user directory/);
});

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
