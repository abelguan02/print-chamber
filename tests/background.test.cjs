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
function harness({history = [], generate, download, localResponse, generationMode = 'local'} = {}) {
  const storage = {token: 'test-token', enabled: true, disabledSites: [], history, generationMode};
  const requests = [];
  const cloudRequests = [];
  const downloads = [];
  let listener;
  const chrome = {
    runtime: {id: 'test-extension', getPlatformInfo: async()=>({}), onInstalled: {addListener() {}}, onMessage: {addListener(fn) {listener = fn;}}},
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
    if (localResponse) return localResponse();
    const payload = generate ? await generate(options, requests.length) : {
      image: image(await options.body.text()), seconds: 1, cached: false
    };
    return {ok: true, json: async () => structuredClone({promptHash, ...payload})};
  }
  const CloudConfig = {active: async()=>({provider:'test-cloud',model:'test-model'}), verified:async()=>{}};
  const Cloud = {generate: async(config, blob)=>{
    cloudRequests.push({config,blob});
    return {image:image(await blob.text()),seconds:1,provider:config.provider,model:config.model};
  }};
  vm.runInNewContext(source, {importScripts(){}, CLOUD_PROMPT: promptContext.CLOUD_PROMPT, Cloud, CloudConfig, chrome, fetch, URL, Blob, AbortSignal, TextEncoder, setInterval, clearInterval, crypto: {randomUUID, subtle: webcrypto.subtle}, console});
  const sender = {id: chrome.runtime.id, tab: {url: 'https://www.artstation.com/artwork/test', title: 'Test artwork'}};
  return {
    storage, requests, downloads, cloudRequests,
    send(message) {return new Promise(resolve => {if (!listener(message, sender, resolve)) resolve();});},
    print(bytes = 'first', extra = {}) {
      return this.send({type: 'generate', url: pictureURL, data: image(bytes), ...extra});
    }
  };
}

for (const oldHash of [undefined, 'old-D-prompt']) {
  test(`old service result (${oldHash}) is not displayed or saved as the current prompt`, async () => {
    const previous = {id:'old', sourceUrl:pictureURL, image:image('old print')};
    const app = harness({history:[previous], generate:async()=>({image:image('old D'), cached:true, promptHash:oldHash})});
    const result = await app.print('replacement', {retry:true});
    assert.match(result.error, /重启本地模型/);
    assert.equal(result.image, undefined);
    assert.deepEqual(app.storage.history, [previous]);
  });
}

test('ordinary viewing reuses the saved print; explicit retry reads changed image bytes', async () => {
  const app = harness();
  const first = await app.print('first image');
  const second = await app.print('replacement image');
  assert.equal(first.error, undefined);
  assert.equal(second.error, undefined);
  assert.equal(second.image, first.image);
  assert.equal(second.fromHistory, true);
  assert.equal(second.recordId, first.recordId);
  assert.equal(app.requests.length, 1);
  const replacement = await app.print('replacement image', {retry:true});
  assert.equal(replacement.image, image('replacement image'));
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
    const inFlight = app.print('updated', {retry:true});
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

for (const generationMode of ['local', 'cloud']) {
  test(`${generationMode} history works without credentials, source download or history rewrite`, async () => {
    const previous = {id:'saved', sourceUrl:pictureURL, image:image('saved result'), createdAt:123, seconds:2};
    const app = harness({generationMode, history:[previous]});
    delete app.storage.token;
    const result = await app.send({type:'generate', url:pictureURL});
    assert.equal(result.image, previous.image);
    assert.equal(result.recordId, previous.id);
    assert.equal(result.fromHistory, true);
    assert.equal(result.cached, true);
    assert.deepEqual(app.storage.history, [previous]);
    assert.equal(app.requests.length + app.downloads.length + app.cloudRequests.length, 0);
  });
}

test('saved results survive a background restart and retain generation metadata', async () => {
  const app = harness({generate:async()=>({image:image('result'), seconds:2, seed:73, width:512, height:768})});
  await app.print();
  const restarted = harness({history:app.storage.history});
  delete restarted.storage.token;
  const result = await restarted.send({type:'preview',url:pictureURL});
  assert.equal(result.image, image('result'));
  assert.equal(result.seed, 73);
  assert.equal(result.promptHash, promptHash);
  assert.equal(result.width, 512);
  assert.equal(result.height, 768);
  assert.equal(restarted.requests.length, 0);
});

test('history can be viewed while another picture is being generated', async () => {
  const started=deferred(), complete=deferred();
  const previous={id:'saved',sourceUrl:pictureURL,image:image('saved')};
  const app=harness({history:[previous],generate:async()=>{
    started.resolve();await complete.promise;return {image:image('new')};
  }});
  const printing=app.print('new',{url:'https://cdna.artstation.com/another.jpg'});
  await started.promise;
  try {
    assert.equal((await app.print()).image, previous.image);
    assert.equal(app.requests.length, 1);
  } finally {complete.resolve();await printing;}
});

test('preview lookup never submits a new generation', async () => {
  const app=harness();
  const preview=await app.send({type:'preview',url:pictureURL});
  assert.equal(preview.needsGeneration, true);
  assert.equal(preview.confirmationRequired, false);
  assert.equal(app.requests.length + app.downloads.length, 0);
});

test('cloud preview and unconfirmed generation or retry never upload an image', async () => {
  const app=harness({generationMode:'cloud'});
  for (const message of [
    {type:'preview',url:pictureURL},
    {type:'generate',url:pictureURL},
    {type:'generate',url:pictureURL,retry:true},
    {type:'generate',url:pictureURL,confirmed:'true'}
  ]) {
    assert.equal((await app.send(message)).confirmationRequired, true);
  }
  assert.equal(app.requests.length + app.downloads.length + app.cloudRequests.length, 0);
  assert.equal(app.storage.history.length, 0);
});

test('cloud confirmation prints once, saved views are free and reprints need confirmation', async () => {
  const app=harness({generationMode:'cloud'});
  const first=await app.print('cloud image',{confirmed:true});
  assert.equal(first.error, undefined);
  assert.equal(app.cloudRequests.length, 1);
  assert.equal(app.storage.history[0].promptHash, promptHash);
  assert.equal(app.storage.history[0].model, 'test-model');
  assert.equal((await app.print()).image, first.image);
  assert.equal((await app.print('new',{retry:true})).confirmationRequired, true);
  assert.equal(app.cloudRequests.length, 1);
  assert.equal((await app.print('new',{retry:true,confirmed:true})).image, image('new'));
  assert.equal(app.cloudRequests.length, 2);
});

test('failed reprinting keeps the previous saved image', async () => {
  const previous={id:'saved',sourceUrl:pictureURL,image:image('saved')};
  const app=harness({history:[previous],localResponse:()=>({ok:false,json:async()=>({error:'生成失败'})})});
  assert.match((await app.print('new',{retry:true})).error,/生成失败/);
  assert.deepEqual(app.storage.history,[previous]);
  assert.equal((await app.print()).image,previous.image);
});

test('paused previews cannot replay history', async () => {
  const app=harness({history:[{id:'saved',sourceUrl:pictureURL,image:image('saved')}]});
  app.storage.enabled=false;
  assert.match((await app.print()).error,/暂停/);
  app.storage.enabled=true;app.storage.disabledSites=['www.artstation.com'];
  assert.match((await app.print()).error,/暂停/);
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

test('approved CDN downloads disallow redirects and explicit reprints revalidate URL content', async () => {
  const png = fs.readFileSync(path.join(__dirname, 'fixtures/artwork.png'));
  let current = png;
  const app = harness({download: async () => new Response(current, {
    headers: {'Content-Type': 'image/png'}
  })});
  const first = await app.send({type: 'generate', url: pictureURL});
  assert.equal(first.image, image(current.toString()));
  current = Buffer.concat([png, Buffer.from('updated')]);
  const saved = await app.send({type: 'generate', url: pictureURL});
  assert.equal(saved.image, first.image);
  assert.equal(app.downloads.length, 1);
  const second = await app.send({type: 'generate', url: pictureURL, retry:true});
  assert.equal(second.image, image(current.toString()));
  assert.equal(app.downloads.length, 2);
  for (const {options} of app.downloads) {
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-cache');
  }
});

for (const [type, body] of [
  ['application/postscript', '%!PS-Adobe-3.0 EPSF-3.0'],
  ['image/jpeg', '%!PS-Adobe-3.0 EPSF-3.0'],
  ['image/png', '<html>error</html>'],
  ['image/webp', 'RIFFfakeNOTP'],
  ['image/png', new Uint8Array([0xff, 0xd8, 0xff])],
  ['image/png', ''],
  ['application/octet-stream', '%!PS-Adobe-3.0 EPSF-3.0']
]) {
  test(`unsupported or mislabeled download is not sent to the service (${type}, ${String(body).slice(0, 12)})`, async () => {
    const app = harness({download: async () => new Response(body, {headers: {'Content-Type': type}})});
    assert.match((await app.send({type:'generate', url:pictureURL})).error, /格式/);
    assert.equal(app.requests.length, 0);
    assert.equal(app.storage.history.length, 0);
  });
}

for (const [type, signature] of [
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/png; charset=binary', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['image/webp', [0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]]
]) {
  test(`download signatures are checked across stream chunks (${type})`, async () => {
    const bytes = Uint8Array.from(signature);
    const app = harness({download: async () => new Response(new ReadableStream({start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    }}), {headers: {'Content-Type': type}})});
    assert.equal((await app.send({type:'generate', url:pictureURL})).error, undefined);
    assert.deepEqual(new Uint8Array(await app.requests[0].body.arrayBuffer()), bytes);
  });
}

for (const status of [200, 502]) {
  test(`non-JSON local response is a Chinese error with no history write (${status})`, async () => {
    const app = harness({localResponse: () => new Response('<html>private server detail</html>', {status})});
    assert.equal((await app.print()).error, '本地服务响应格式异常，请检查服务日志后重试');
    assert.equal(app.storage.history.length, 0);
    assert.equal((await app.print()).error, '本地服务响应格式异常，请检查服务日志后重试', 'failure releases busy state');
  });
}

test('local response read timeouts keep the timeout message', async () => {
  const app = harness({localResponse: () => ({json: async () => {throw new DOMException('timed out', 'TimeoutError');}})});
  assert.match((await app.print()).error, /等待超时/);
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
