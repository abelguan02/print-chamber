const { test } = require('node:test');
const assert = require('node:assert/strict');
const { version } = require('../extension/manifest.json');

test('npm package and lockfile match the extension release version', () => {
  const lock = require('../package-lock.json');
  assert.equal(require('../package.json').version, version);
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
});
