'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadDataset, prepareSample, writeReport } = require('./report.cjs');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g3-report-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('copies verified source bytes and preserves all prompt whitespace', async t => {
  const dataset = await tempDir(t);
  const out = await tempDir(t);
  const source = Buffer.from('known source');
  const g3 = ' G3\r\n';
  const sources = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1, path: path.join(dataset, `${i + 1}.jpg`),
    sha256: createHash('sha256').update(source).digest('hex'),
  }));
  await Promise.all([
    fs.writeFile(path.join(dataset, 'metrics.json'), JSON.stringify({ sources })),
    fs.writeFile(path.join(dataset, 'prompt.txt'), g3),
    fs.writeFile(sources[0].path, source),
    fs.writeFile(path.join(dataset, '1-G3.png'), 'reference'),
  ]);
  const data = await loadDataset(dataset);
  assert.equal(data.g3, g3);
  assert.equal(data.g3Sha256, createHash('sha256').update(g3).digest('hex'));
  const files = await prepareSample(dataset, data.sources[0], out);
  assert.deepEqual(await fs.readFile(path.join(out, files.sourceImage)), source);
  assert.equal(await fs.readFile(path.join(out, files.fluxImage), 'utf8'), 'reference');
  await fs.writeFile(sources[1].path, 'changed');
  await assert.rejects(prepareSample(dataset, data.sources[1], out), /SHA-256/);
  assert.equal((await fs.readdir(out)).length, 2);
});

test('findings distinguish plans, attempts, actual images and window resets', async t => {
  const dir = await tempDir(t);
  const quota = (used, reset) => ({ rateLimits: { limitId: 'sample', primary: {
    usedPercent: used, resetsAt: reset, windowDurationMins: 300,
  } } });
  const records = [
    { id: 1, status: 'success', attempted: true, imageToolCalled: true, referenceHashMatched: true,
      outputImage: '1.png', durationMs: 2000, width: 32, height: 32, format: 'PNG',
      rateLimitsBefore: quota(30, 200), rateLimitsAfter: quota(31, 200) },
    { id: 2, status: 'failed', attempted: true, imageToolCalled: true, durationMs: 3000,
      rateLimitsBefore: quota(98, 200), rateLimitsAfter: quota(1, 301), error: '<img src=x>' },
    { id: 3, status: 'skipped', attempted: false },
  ];
  const results = { records };
  await writeReport(dir, results);
  const findings = JSON.parse(await fs.readFile(path.join(dir, 'results.json'))).findings;
  assert.equal(findings.length, 7);
  assert.deepEqual(findings[0].matchedSamples, [1]);
  assert.equal(findings[1].attempted, 2);
  assert.equal(findings[1].produced, 1);
  assert.equal(findings[1].fullSetRate, null);
  assert.equal(findings[2].medianMs, 2000);
  assert.equal(findings[3].perSample[0].changes[0].changeInPercentagePoints, 1);
  assert.equal(findings[3].perSample[1].changes[0].changeInPercentagePoints, null);
  const html = await fs.readFile(path.join(dir, 'comparison.html'), 'utf8');
  assert.match(html, /src="1.png"/);
  assert.match(html, /&lt;img src=x&gt;/);
  for (const id of [4, 5]) records.push({ id, status: 'skipped', attempted: false });
  await writeReport(dir, results);
  assert.equal(results.findings[1].measuredRate, 1 / 2);
  assert.equal(results.findings[1].skipped, 3);
  assert.equal(results.findings[1].fullSetRate, null);
  for (const record of records.slice(2)) Object.assign(record, { attempted: true, status: 'failed' });
  await writeReport(dir, results);
  assert.equal(results.findings[1].skipped, 0);
  assert.equal(results.findings[1].fullSetRate, 1 / 5);
});

test('dry run cannot report fabricated observations', async t => {
  const dir = await tempDir(t);
  const results = { mode: 'dry-run', records: [] };
  await writeReport(dir, results);
  assert.equal(results.findings[1].measuredRate, null);
  assert.equal(results.findings[1].fullSetRate, null);
  assert.equal(results.findings[2].medianMs, null);
  assert.equal(results.findings[2].maxMs, null);
  assert.deepEqual(results.findings[4].images, []);
  assert.equal(results.findings[5].featureDisabled, '未验证');

  results.records = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1, attempted: false, status: 'skipped',
  }));
  await writeReport(dir, results);
  assert.equal(results.findings[1].skipped, 5);
  assert.equal(results.findings[1].attempted, 0);
  assert.equal(results.findings[1].measuredRate, null);
  assert.equal(results.findings[1].fullSetRate, null);
});
