'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { findDesktopCli } = require('./desktop-cli.cjs');

const macOS = { skip: process.platform !== 'darwin' };

async function bundle(app, id, name = 'codex') {
  const dir = path.join(app, 'Contents');
  await fs.mkdir(path.join(dir, 'MacOS'), { recursive: true });
  await fs.writeFile(path.join(dir, 'Info.plist'), `<?xml version="1.0"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleExecutable</key><string>${name}</string></dict></plist>`);
  const binary = path.join(dir, 'MacOS', 'codex');
  await fs.writeFile(binary, 'fixture', { mode: 0o700 });
  return binary;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-desktop-locator-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'ChatGPT.app');
  await bundle(app, 'com.openai.codex');
  const helpers = path.join(app, 'Contents', 'Resources', 'some-new-layout');
  await fs.mkdir(helpers, { recursive: true });
  return { root, app, helpers };
}

test('selects the CLI by both bundle identifiers, even if its location and bundle name change', macOS, async t => {
  const { app, helpers } = await fixture(t);
  await bundle(path.join(helpers, 'Unrelated.app'), 'other.vendor.cli');
  const cli = await bundle(path.join(helpers, 'Renamed.app'), 'com.openai.codex.cli');
  assert.equal(await findDesktopCli(app), cli);
  await bundle(app, 'other.vendor.desktop');
  await assert.rejects(findDesktopCli(app), /预期的 ChatGPT/);
});

test('missing, linked or ambiguous CLI bundles cannot select another installed executable', macOS, async t => {
  const { root, app, helpers } = await fixture(t);
  const outside = path.join(root, 'External.app');
  await bundle(outside, 'com.openai.codex.cli');
  await fs.symlink(outside, path.join(helpers, 'Linked.app'));
  await assert.rejects(findDesktopCli(app), /0 份匹配/);
  await bundle(path.join(helpers, 'One.app'), 'com.openai.codex.cli');
  await bundle(path.join(helpers, 'Two.app'), 'com.openai.codex.cli');
  await assert.rejects(findDesktopCli(app), /2 份匹配/);
});

test('rejects metadata and executable paths that could lead outside the CLI bundle', macOS, async t => {
  const { app, helpers } = await fixture(t);
  const helper = path.join(helpers, 'CLI.app');
  const cli = await bundle(helper, 'com.openai.codex.cli', '../../outside');
  await assert.rejects(findDesktopCli(app), /文件名无效/);
  await bundle(helper, 'com.openai.codex.cli');
  await fs.unlink(cli);
  await fs.symlink('/usr/bin/true', cli);
  await assert.rejects(findDesktopCli(app), /可执行路径无效/);
  const plist = path.join(helper, 'Contents', 'Info.plist');
  await fs.unlink(plist);
  await fs.symlink(path.join(app, 'Contents', 'Info.plist'), plist);
  await assert.rejects(findDesktopCli(app), /元数据路径无效/);
});
