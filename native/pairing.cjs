'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {randomUUID} = require('node:crypto');
const manifest = require('../extension/manifest.json');

async function stateDirectory() {
  if (process.env.PRINT_CHAMBER_MODE !== 'app')
    return process.env.PRINT_CHAMBER_STATE || path.join(__dirname, '../.local');
  const standard = path.join(os.homedir(), 'Library/Application Support/Print Chamber');
  try {
    const binding = JSON.parse(await fs.readFile(path.join(standard, 'NativeMessaging/app-state.json'), 'utf8'));
    if (!path.isAbsolute(binding.state)) throw Error('本机助手数据目录无效');
    return binding.state;
  } catch (error) {
    if (error.code !== 'ENOENT') throw Error('无法读取本机助手数据目录');
    return standard;
  }
}

async function pair(request) {
  const state = await stateDirectory();
  if (request.type === 'local-token') {
    try {
      const token = (await fs.readFile(path.join(state, 'token'), 'utf8')).trim();
      if (!token || token.length > 1024 || /[\r\n]/.test(token)) throw Error('本地连接码格式无效');
      return {token};
    } catch (error) {
      if (error.code === 'ENOENT') return {token:null};
      throw Error('无法读取本地连接码');
    }
  }
  if (typeof request.version !== 'string' || !/^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(request.version)) throw Error('扩展版本无效');
  await fs.mkdir(state, {recursive:true, mode:0o700});
  const tmp = path.join(state, '.extension-seen-' + randomUUID());
  try {
    await fs.writeFile(tmp, JSON.stringify({version:request.version, time:new Date().toISOString()}), {mode:0o600, flag:'wx'});
    await fs.rename(tmp, path.join(state, 'extension-seen.json'));
  } finally {
    await fs.rm(tmp, {force:true});
  }
  // The bundle builder uses this manifest as the app version's source of truth.
  return {appVersion:manifest.version, extensionVersion:manifest.version};
}
module.exports = {pair};
