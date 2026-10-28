const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID, webcrypto, createHash} = require('node:crypto');
const promptSource = fs.readFileSync(path.join(__dirname, '../extension/cloud-prompt.js'), 'utf8');
const promptContext = {}; vm.runInNewContext(promptSource, promptContext);
const promptHash = createHash('sha256').update(promptContext.CLOUD_PROMPT).digest('hex');

const source = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
const pictureURL = 'https://cdna.artstation.com/art.jpg';
const image = bytes => 'data:image/jpeg;base64,' + Buffer.from(bytes).toString('base64');
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
}
function harness({history = [], generate, download} = {}) {
  const storage = {token: 'test-token', enabled: true, disabledSites: [], history};
  const requests = [];
  const downloads = [];
  let listener;
  const chrome = {
    runtime: {id: 'test-extension', onInstalled: {addListener() {}}, onMessage: {addListener(fn) {listener = fn;}}},
    storage: {local: {
      async get(keys) {
        const selected = typeof keys === 'string' ? [keys] : keys;
        return structuredClone(Object.fromEntries(selected.map(key => [key, storage[key]])));
      },
      async set(values) {Object.assign(storage, structuredClone(values));}
    }}
  };
  async function fetch(url, options) {
    if (String(url).startsWith('data:')) {
      const body = Buffer.from(String(url).split(',')[1], 'base64');
      return {blob: async () => new Blob([body], {type: 'image/jpeg'})};
    }
    if (String(url) !== 'http://127.0.0.1:8877/generate') {
      downloads.push({url: String(url), options});
      assert.ok(download, 'unexpected remote image request');
      return download(String(url), options);
    }
    requests.push(options);
    const payload = generate ? await generate(options, requests.length) : {
      image: image(await options.body.text()), seconds: 1, cached: false
    };
    return {ok: true, json: async () => structuredClone({promptHash, ...payload})};
  }
  vm.runInNewContext(source, {importScripts(){}, CLOUD_PROMPT: promptContext.CLOUD_PROMPT, chrome, fetch, URL, Blob, AbortSignal, TextEncoder, crypto: {randomUUID, subtle: webcrypto.subtle}, console});
  const sender = {id: chrome.runtime.id, tab: {url: 'https://www.artstation.com/artwork/test', title: 'Test artwork'}};
  return {
    storage, requests, downloads,
    send(message) {return new Promise(resolve => listener(message, sender, resolve));},
    print(bytes = 'first', extra = {}) {
      return this.send({type: 'generate', url: pictureURL, data: image(bytes), ...extra});
    }
  };
}

for (const oldHash of [undefined, 'old-D-prompt']) {
  test(`old service result (${oldHash}) is not displayed or saved as the current prompt`, async () => {
    const previous = {id:'old', sourceUrl:pictureURL, image:image('old print')};
    const app = harness({history:[previous], generate:async()=>({image:image('old D'), cached:true, promptHash:oldHash})});
    const result = await app.print();
    assert.match(result.error, /重启本地模型/);
    assert.equal(result.image, undefined);
    assert.deepEqual(app.storage.history, [previous]);
  });
}

test('the same URL with changed image bytes generates the changed image', async () => {
  const app = harness();
  const first = await app.print('first image');
  const second = await app.print('replacement image');
  assert.equal(first.error, undefined);
  assert.equal(second.error, undefined);
  assert.equal(second.image, image('replacement image'));
  assert.equal(app.requests.length, 2);
});

for (const mode of ['single', 'batch']) {
  test(`${mode} deletion prevents an earlier in-flight print restoring history, but allows a later print`, async () => {
    const started = deferred();
    const complete = deferred();
    const existing = {id: 'existing', sourceUrl: pictureURL, image: image('previous')};
    const app = harness({history: [existing], generate: async (_options, count) => {
      if (count === 1) {started.resolve(); await complete.promise;}
      return {image: image('rendered'), seconds: 1, cached: false};
    }});
    const inFlight = app.print('updated');
    await started.promise;
    const deleted = await app.send(mode === 'single'
      ? {type: 'delete-history', sourceUrl: pictureURL}
      : {type: 'delete-history-batch', ids: ['existing']});
    assert.equal(deleted.ok, true);
    assert.equal(app.storage.history.length, 0);
    complete.resolve();
    assert.equal((await inFlight).error, undefined);
    assert.equal(app.storage.history.length, 0, 'a completed deleted request must not recreate history');
    assert.equal((await app.print('after deletion')).error, undefined);
    assert.equal(app.storage.history.length, 1, 'a new explicit request may create history again');
  });
}

test('retry propagates an explicit refresh request to the local service', async () => {
  const app = harness();
  assert.equal((await app.print('image', {retry: true})).error, undefined);
  assert.equal(new Headers(app.requests[0].headers).get('X-Print-Chamber-Refresh'), '1');
});

for (const url of [
  'https://example.com/image.jpg',
  'https://evilartstation.com/image.jpg',
  'https://artstation.com.evil.example/image.jpg',
  'https://172.16.0.1/image.jpg',
  'https://169.254.169.254/image.jpg',
  'https://127.0.0.1/image.jpg',
  'https://[::1]/image.jpg',
  'https://user:password@cdna.artstation.com/image.jpg',
  'https://cdna.artstation.com:8443/image.jpg'
]) {
  test(`rejects unapproved image target before network access: ${url}`, async () => {
    const app = harness();
    const result = await app.send({type: 'generate', url});
    assert.ok(result.error);
    assert.equal(app.downloads.length, 0);
    assert.equal(app.requests.length, 0);
  });
}

test('approved CDN downloads disallow redirects and revalidate repeated URL content', async () => {
  let current = 'first image';
  const app = harness({download: async () => new Response(current, {
    headers: {'Content-Type': 'image/jpeg'}
  })});
  const first = await app.send({type: 'generate', url: pictureURL});
  assert.equal(first.image, image('first image'));
  current = 'new image at same URL';
  const second = await app.send({type: 'generate', url: pictureURL});
  assert.equal(second.image, image(current));
  assert.equal(app.downloads.length, 2);
  for (const {options} of app.downloads) {
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-cache');
  }
});

test('rejects an unexpected final response URL without forwarding image bytes', async () => {
  const response = new Response('private content');
  Object.defineProperty(response, 'url', {value: 'https://172.16.0.1/private.jpg'});
  const app = harness({download: async () => response});
  const result = await app.send({type: 'generate', url: pictureURL});
  assert.ok(result.error);
  assert.equal(app.requests.length, 0);
});

test('remote download failure is not mislabeled as a stopped local model', async () => {
  const app = harness({download: async () => {throw new TypeError('Failed to fetch');}});
  const result = await app.send({type: 'generate', url: pictureURL});
  assert.match(result.error, /网站图片读取失败/);
  assert.equal(app.requests.length, 0);
});

for (const declaredLength of [undefined, '12000001', '1']) {
  test(`oversized download is rejected and cancelled (Content-Length: ${declaredLength ?? 'absent'})`, async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {controller.enqueue(new Uint8Array(6000001));},
      cancel() {cancelled = true;}
    });
    const headers = {'Content-Type': 'image/jpeg'};
    if (declaredLength !== undefined) headers['Content-Length'] = declaredLength;
    const app = harness({download: async () => new Response(stream, {headers})});
    const result = await app.send({type: 'generate', url: pictureURL});
    assert.match(result.error, /图片文件过大/);
    assert.equal(app.requests.length, 0);
    assert.equal(cancelled, true, 'rejecting an oversized body must cancel its download');
  });
}
