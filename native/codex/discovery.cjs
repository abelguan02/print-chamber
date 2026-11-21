'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {findDesktopCli} = require('./desktop-cli.cjs');
const {verifyOfficialCodex} = require('./isolation.cjs');

// Resolve only the three installation links and known application bundles.
async function findCodex(inspect, {
  standalone = [path.join(os.homedir(), '.local/bin/codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex'],
  desktop = ['/Applications/ChatGPT.app', '/Applications/Codex.app'],
  resolve = fs.realpath, bundleCli = findDesktopCli, verify = verifyOfficialCodex,
  report = message => console.error(message),
} = {}) {
  const seen = new Set();
  for (const [source, paths] of [['standalone', standalone], ['desktop', desktop]]) {
    for (const candidate of paths) {
      let cli;
      try {
        cli = await resolve(source === 'desktop' ? await bundleCli(candidate) : candidate);
      } catch (error) {
        if (error.code !== 'ENOENT') report(source + '：无法定位安装');
        continue;
      }
      if (seen.has(cli)) continue;
      seen.add(cli);
      try {
        await verify(cli);
      } catch {
        report(source + '：签名校验失败');
        continue;
      }
      try {
        return {found:true, source, ...await inspect(cli)};
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        report(source + '：' + (error.code === 'PROCESS_ISOLATION_UNAVAILABLE' ? '无法启用进程隔离' : '隔离启动或版本检查失败'));
      }
    }
  }
  return {found:false, source:null, version:null};
}

module.exports = {findCodex};
