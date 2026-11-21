'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const seatbelt = '/usr/bin/sandbox-exec';
const execRules = `(deny process-exec)
(allow process-exec (literal (param "CLI")))`;
const generationRules = `(deny file-write*)
(allow file-write* (subpath (param "RUN_DIR")))
(allow file-write-data (literal "/dev/null"))
(deny process-fork)`;
const desktopImageRules = `${generationRules}
(allow file-write-create file-write-data (require-all
  (vnode-type REGULAR-FILE) (literal (param "INSTALLATION_ID"))))
(allow file-write-create file-write-mode (require-all
  (vnode-type DIRECTORY) (literal (param "CODEX_TMP"))))
(allow file-write* (subpath (param "ARG0_DIR")))`;

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function verifyOfficialCodex(cli) {
  // The signed executable in the CLI bundle uses a separate code identifier.
  const requirement = '=anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2" and identifier "codex"';
  try {
    await promisify(execFile)('/usr/bin/codesign', ['--verify', '-R', requirement, cli], {
      env: { PATH: '/usr/bin:/bin' }, timeout: 10000,
    });
  } catch {
    throw new Error('macOS 未能验证这份 Codex 的 OpenAI 签名，已在启动前停止。');
  }
}

async function createLauncher(tempRoot, baseEnv, cli, verify, extraRules, stateParams = []) {
  if (process.platform !== 'darwin') {
    throw new Error('本机 Codex 启动器需要 macOS。');
  }
  const runDir = await fs.realpath(tempRoot);
  const binDir = await fs.mkdtemp(path.join(runDir, 'launcher-'));
  const file = path.join(binDir, 'launcher.sb');
  const profile = ['(version 1)', '(allow default)', extraRules, execRules, ''].join('\n');
  await fs.writeFile(file, profile, { mode: 0o600 });
  const policy = executable => [
    '-D', 'RUN_DIR=' + runDir, '-D', 'CLI=' + executable, ...stateParams, '-f', file, executable,
  ];
  try {
    await promisify(execFile)(seatbelt, policy('/usr/bin/true'), {
      cwd: runDir, env: { PATH: '/usr/bin:/bin' }, timeout: 5000,
    });
  } catch {
    throw Object.assign(new Error('macOS 未能启用本次启动所需的进程权限限制，Codex 服务尚未启动。'), {
      code: 'PROCESS_ISOLATION_UNAVAILABLE',
    });
  }
  await verify(cli);
  const script = [
    '#!/bin/sh',
    'export PATH=' + shellQuote(baseEnv.PATH),
    'exec ' + [seatbelt, ...policy(cli)].map(shellQuote).join(' ') + ' "$@"',
    '',
  ].join('\n');
  await fs.writeFile(path.join(binDir, 'codex'), script, { mode: 0o700 });
  return { ...baseEnv, PATH: binDir + path.delimiter + baseEnv.PATH };
}

function isolateGeneration(tempRoot, baseEnv, cli, verify = verifyOfficialCodex) {
  return createLauncher(tempRoot, baseEnv, cli, verify, generationRules);
}

function isolateLoginCheck(tempRoot, baseEnv, cli, verify = verifyOfficialCodex) {
  // Login and capability queries let the signed service maintain its normal state.
  return createLauncher(tempRoot, baseEnv, cli, verify, '');
}

function isolateDesktopImage(tempRoot, baseEnv, cli, verify = verifyOfficialCodex) {
  const stateDir = baseEnv.CODEX_HOME || (baseEnv.HOME && path.join(baseEnv.HOME, '.codex'));
  if (!stateDir || !path.isAbsolute(stateDir)) {
    throw new Error('无法确认桌面 Codex 的运行目录，已在启动前停止。');
  }
  // Derive sandbox filters without opening or resolving the user's state directory.
  const tmp = path.join(stateDir, 'tmp');
  return createLauncher(tempRoot, baseEnv, cli, verify, desktopImageRules, [
    '-D', 'INSTALLATION_ID=' + path.join(stateDir, 'installation_id'),
    '-D', 'CODEX_TMP=' + tmp,
    '-D', 'ARG0_DIR=' + path.join(tmp, 'arg0-macos'),
  ]);
}

module.exports = { isolateGeneration, isolateLoginCheck, isolateDesktopImage };
