'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function temporaryLoginEnvironment(tempRoot, baseEnv) {
  const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: path.join(tempRoot, 'home'),
    CODEX_HOME: path.join(tempRoot, 'profile'),
    TMPDIR: path.join(tempRoot, 'tmp'),
    CODEX_SQLITE_HOME: tempRoot,
  };
  if (baseEnv.LANG) env.LANG = baseEnv.LANG;
  if (baseEnv.LC_ALL) env.LC_ALL = baseEnv.LC_ALL;
  await Promise.all([env.HOME, env.CODEX_HOME, env.TMPDIR].map(dir => fs.mkdir(dir, { mode: 0o700 })));
  // Both the official login command and the confined server use this profile.
  await fs.writeFile(path.join(env.CODEX_HOME, 'config.toml'),
    'forced_login_method = "chatgpt"\ncli_auth_credentials_store = "file"\n', { mode: 0o600, flag: 'wx' });
  return env;
}

async function loginInTerminal(cliPath, cwd, env, signal) {
  signal.throwIfAborted();
  // The user's terminal and the CLI communicate directly throughout sign-in.
  const child = spawn(cliPath, ['login'], { cwd, env, stdio: 'inherit' });
  let killTimer;
  const stop = () => {
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const [code, exitSignal] = await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('无法启动官方 Codex 登录程序。')));
      child.once('close', (status, reason) => resolve([status, reason]));
    });
    if (signal.aborted) throw new Error('临时登录已取消。');
    if (code !== 0) throw new Error('官方登录程序未成功完成（' + (exitSignal || '退出码 ' + code) + '）。');
  } finally {
    clearTimeout(killTimer);
    signal.removeEventListener('abort', stop);
  }
}

module.exports = { temporaryLoginEnvironment, loginInTerminal };
