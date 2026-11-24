const { test } = require('node:test');
const assert = require('node:assert/strict');
const { version } = require('../extension/manifest.json');

test('npm package and lockfile match the extension release version', () => {
  const lock = require('../package-lock.json');
  assert.equal(require('../package.json').version, version);
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
});

test('all installation guides specify the supported macOS minimum', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const name of ['README.md','DEVELOPMENT.md','release/RELEASE_NOTES.md','menu-helper/使用说明.txt']) {
    const guide = fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8');
    assert.match(guide, /macOS 14/, name);
    assert.doesNotMatch(guide, /macOS 13/, name);
  }
});
