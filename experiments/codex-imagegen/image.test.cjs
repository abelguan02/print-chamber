'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectImage } = require('./image.cjs');

// Three encodings of the same synthetic 4 × 2 blue rectangle.
const fixtures = {
  PNG: 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGNkYPjLAAMsDEgAABcjAQPGhqsAAAAAAElFTkSuQmCC',
  JPEG: '/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAyAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAHAQEBAAAAAAAAAAAAAAAAAAAFBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIABAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AI4Av4p//9k=',
  WebP: 'UklGRjoAAABXRUJQVlA4IC4AAACwAQCdASoEAAIAAgA0JaACdLoABDAAAP75k2//kB//kB//kB//ID/iF3sYUAAA',
};
const sha = '01'.repeat(32);
const complete = { type: 'imageGeneration', status: 'completed' };

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-collect-'));
  const temp = path.join(dir, 'temp');
  const output = path.join(dir, 'output');
  fs.mkdirSync(temp);
  fs.mkdirSync(output);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, temp, output, collect: item => collectImage(item, temp, output, 1, sha) };
}

for (const [format, result] of Object.entries(fixtures)) {
  test(`decodes ${format}, measures actual pixels and retains original bytes`, { skip: process.platform !== 'darwin' }, t => {
    const { collect, output, dir } = setup(t);
    const savedPath = path.join(dir, 'elsewhere');
    const image = collect({ ...complete, result, inputImages: [{ sha256: sha }], savedPath });
    assert.equal(image.error, null);
    assert.equal(image.format, format);
    assert.equal(image.width, 4);
    assert.equal(image.height, 2);
    assert.equal(image.reportedPath, savedPath);
    assert.equal(image.referenceHashMatched, true);
    assert.deepEqual(fs.readFileSync(path.join(output, image.outputImage)), Buffer.from(result, 'base64'));
  });
}

test('accepts a confined nested file and prefers valid inline data', { skip: process.platform !== 'darwin' }, t => {
  const { temp, collect } = setup(t);
  fs.mkdirSync(path.join(temp, 'nested'));
  const savedPath = path.join(temp, 'nested', 'image');
  fs.writeFileSync(savedPath, Buffer.from(fixtures.JPEG, 'base64'));
  const fallback = collect({ ...complete, result: 'broken', savedPath, inputImages: [{ sha256: 'xx' }] });
  assert.equal(fallback.error, null);
  assert.equal(fallback.format, 'JPEG');
  assert.equal(fallback.referenceHashMatched, false);
  const preferred = collect({ ...complete, result: fixtures.PNG, savedPath });
  assert.equal(preferred.error, null);
  assert.equal(preferred.format, 'PNG');
});

test('rejects external, traversal, symbolic links, hard links and loops', { skip: process.platform !== 'darwin' }, t => {
  const { dir, temp, output, collect } = setup(t);
  const external = path.join(dir, 'external');
  fs.writeFileSync(external, Buffer.from(fixtures.PNG, 'base64'));
  fs.symlinkSync(dir, path.join(temp, 'outside'));
  fs.symlinkSync(external, path.join(temp, 'filelink'));
  fs.symlinkSync('loop', path.join(temp, 'loop'));
  fs.linkSync(external, path.join(temp, 'hardlink'));
  for (const savedPath of [external, `${temp}/../external`, path.join(temp, 'outside', 'external'),
    path.join(temp, 'filelink'), path.join(temp, 'loop'), path.join(temp, 'hardlink'), 'relative']) {
    const image = collect({ ...complete, savedPath });
    assert.ok(image.error);
    assert.equal(image.outputImage, null);
    assert.equal(image.reportedPath, savedPath);
  }
  assert.deepEqual(fs.readdirSync(output), []);
});

test('rejects failed tools, text replies, missing attachments and damaged pixel payloads', t => {
  const { collect, output } = setup(t);
  const corrupt = Buffer.from(fixtures.PNG, 'base64');
  corrupt.fill(255, corrupt.indexOf('IDAT') + 4, corrupt.indexOf('IDAT') + 12);
  for (const item of [{ ...complete, result: corrupt.toString('base64') }, { ...complete, fileId: 'only-an-id' },
    { ...complete, result: 'not-base64' }, { ...complete, status: 'failed', result: fixtures.PNG },
    { ...complete, failure: { message: 'failed' }, result: fixtures.PNG }, { type: 'agentMessage', text: fixtures.PNG }]) {
    const image = collect(item);
    assert.ok(image.error);
    assert.equal(image.outputImage, null);
    assert.equal(image.referenceHashMatched, null);
  }
  assert.deepEqual(fs.readdirSync(output), []);
});
