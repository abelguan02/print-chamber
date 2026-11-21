'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const options = { env: { PATH: '/usr/bin:/bin' }, timeout: 10000 };

async function bundlePlist(bundle) {
  const contents = path.join(bundle, 'Contents');
  const plist = path.join(contents, 'Info.plist');
  if (!(await fs.lstat(contents)).isDirectory() || !(await fs.lstat(plist)).isFile()) {
    throw new Error('桌面端应用包内的元数据路径无效。');
  }
  return plist;
}

async function plistString(plist, key) {
  const { stdout } = await exec('/usr/bin/plutil', ['-extract', key, 'raw', '-expect', 'string', '-o', '-', plist], options);
  return stdout.trimEnd();
}

async function findDesktopCli(app = '/Applications/ChatGPT.app') {
  if (process.platform !== 'darwin') throw new Error('桌面端 Codex 定位需要 macOS。');
  const installed = await fs.lstat(app).catch(error => {
    if (error.code === 'ENOENT') throw new Error('在系统应用程序目录中未找到 ChatGPT 桌面端。');
    throw error;
  });
  if (!installed.isDirectory() || await plistString(await bundlePlist(app), 'CFBundleIdentifier') !== 'com.openai.codex') {
    throw new Error('此安装位置没有预期的 ChatGPT 桌面端应用包。');
  }

  // Search only bundle directories in the installation. -P never follows a link,
  // and -prune avoids descending into other self-contained apps.
  const { stdout } = await exec('/usr/bin/find', [
    '-P', path.join(app, 'Contents'), '-type', 'd', '-name', '*.app', '-print0', '-prune',
  ], options);
  const matches = [];
  for (const bundle of stdout.split('\0').filter(Boolean)) {
    const plist = await bundlePlist(bundle);
    if (await plistString(plist, 'CFBundleIdentifier') === 'com.openai.codex.cli') matches.push({ bundle, plist });
  }
  if (matches.length !== 1) throw new Error(`桌面端包含 ${matches.length} 份匹配的 Codex，无法唯一定位。`);

  const { bundle, plist } = matches[0];
  const name = await plistString(plist, 'CFBundleExecutable');
  if (!name || name === '.' || name === '..' || path.basename(name) !== name) {
    throw new Error('桌面端 Codex 的可执行文件名无效。');
  }
  const dir = path.join(bundle, 'Contents', 'MacOS');
  const cli = path.join(dir, name);
  if (!(await fs.lstat(dir)).isDirectory() || !(await fs.lstat(cli)).isFile()) {
    throw new Error('桌面端 Codex 的可执行路径无效。');
  }
  await fs.access(cli, constants.X_OK);
  return cli;
}

module.exports = { findDesktopCli };
