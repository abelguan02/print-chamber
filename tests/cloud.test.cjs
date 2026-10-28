const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../extension/cloud.js'),'utf8');
function app(fetch=()=>{throw Error('unexpected network');}){const ctx={fetch,URL,Blob,AbortSignal,Uint8Array,btoa,setTimeout};vm.runInNewContext(source,ctx);return ctx.Cloud;}
const config=provider=>({provider,model:app().providers[provider].models[0],key:'fake-test-key',workspace:'test-workspace',region:'cn-beijing'});
const image='data:image/png;base64,YWJj';
test('cloud prompt is exactly the approved local prompt',()=>{
 const ctx={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/cloud-prompt.js'),'utf8'),ctx);
 const local=fs.readFileSync(path.join(__dirname,'../benchmark_local.py'),'utf8').match(/PROMPT = """([\s\S]*?)"""/)[1];assert.equal(ctx.CLOUD_PROMPT,local);
});
for(const p of Object.keys(app().providers))test(`${p} builds an image edit, not text-only generation`,()=>{
 const c=config(p),req=app().build(c,image,'exact prompt');
 assert.ok(req.url.startsWith('https://'));if(p==='bfl')assert.ok(req.url.endsWith(c.model));else assert.equal(req.body.model,c.model);
 assert.ok(JSON.stringify(req.body).includes('YWJj'));assert.ok(JSON.stringify(req.body).includes('exact prompt'));
 assert.ok(!JSON.stringify(req).includes(c.key));
});
test('untrusted provider, model and workspace cannot redirect credentials',()=>{
 for(const patch of [{provider:'__proto__'},{model:'arbitrary'},{provider:'ali',model:'qwen-image-2.0',workspace:'evil.com/path'},{key:'x\r\nAuthorization: secret'}])assert.throws(()=>app().build({...config('volc'),...patch},image,'p'));
});
test('Gemini request carries source aspect ratio rather than defaulting to square',()=>{
 assert.equal(app().build(config('google'),image,'p','9:16').body.response_format.aspect_ratio,'9:16');
});
test('all response formats extract image data, text-only result is not success',()=>{
 assert.equal(app().extract(config('volc'),{data:[{b64_json:'YWJj'}]}),'data:image/jpeg;base64,YWJj');
 assert.equal(app().extract(config('ali'),{output:{choices:[{message:{content:[{image:'https://example.aliyuncs.com/x'}]}}]}}),'https://example.aliyuncs.com/x');
 assert.equal(app().extract(config('google'),{steps:[{type:'model_output',content:[{type:'image',data:'YWJj',mime_type:'image/png'}]}]}),image);
 assert.equal(app().extract(config('google'),{output_image:{data:'YWJj',mime_type:'image/png'}}),image);
 assert.ok(!app().extract(config('google'),{steps:[]}));
});
for(const p of Object.keys(app().providers))test(`${p} connection check never submits an image or billable POST`,async()=>{
 const calls=[];const api=app(async(url,o)=>{calls.push({url,o});return new Response('{}',{status:p==='google'?200:405});});
 const result=await api.check(config(p));assert.equal(calls.length,1);assert.equal(calls[0].o.method,'GET');assert.equal(calls[0].o.body,undefined);
 assert.equal(calls[0].o.redirect,'error');assert.equal(result.authenticated,p==='google');assert.match(result.message,/未验证/);
});
test('MiniMax sends the unchanged prompt, one character reference and one output to the selected region',()=>{
 for(const p of ['minimax-cn','minimax']){
  const r=app().build(config(p),image,'exact prompt','3:4');assert.equal(r.url,p==='minimax-cn'?'https://api.minimax.cn/v1/image_generation':'https://api.minimax.io/v1/image_generation');
  assert.equal(r.body.prompt,'exact prompt');assert.equal(r.body.prompt_optimizer,false);assert.equal(r.body.n,1);assert.equal(r.body.response_format,'base64');
  assert.equal(r.body.subject_reference.length,1);assert.equal(r.body.subject_reference[0].image_file,image);assert.equal(r.body.subject_reference[0].type,'character');
 }
});
test('MiniMax business errors within HTTP 200 are rejected without echoing private messages',()=>{
 const c=config('minimax'),api=app();
 assert.equal(api.extract(c,{base_resp:{status_code:0},data:{image_base64:['YWJj']}}),'data:image/jpeg;base64,YWJj');
 assert.throws(()=>api.extract(c,{base_resp:{status_code:1004,status_msg:'secret'},data:{image_base64:['YWJj']}}),e=>e.message.includes('1004')&&!e.message.includes('secret'));
 assert.throws(()=>api.extract(c,{data:{image_base64:['YWJj']}}),/缺少成功状态/);
 assert.equal(api.extract(c,{base_resp:{status_code:0},data:{image_base64:[]}}),null);
});
test('BFL polling authenticates only trusted result endpoints and terminates on failures',async()=>{
 let calls=0;const api=app(async(url,o)=>{calls++;assert.equal(o.headers['x-key'],'fake-test-key');return new Response(JSON.stringify({status:'Failed'}));});
 await assert.rejects(api.poll(config('bfl'),{polling_url:'https://evil.test/v1/get_result'},Date.now()+1000),/不受信任/);assert.equal(calls,0);
 await assert.rejects(api.poll(config('bfl'),{polling_url:'https://api.eu.bfl.ai/v1/get_result?id=1'},Date.now()+1000),/生成失败/);assert.equal(calls,1);
 await assert.rejects(api.poll(config('bfl'),{polling_url:'https://api.bfl.ai/v1/get_result?id=1'},Date.now()-1),/超时/);assert.equal(calls,1);
 for(const url of ['http://delivery.eu.bfl.ai/x','https://delivery.eu.bfl.ai.evil.test/x','https://api.bfl.ai@evil.test/x','https://127.0.0.1/x'])assert.throws(()=>api.bflURL(url,true));
 assert.equal(api.bflURL('https://delivery.eu.bfl.ai/result.jpg',true),'https://delivery.eu.bfl.ai/result.jpg');
});
test('provider errors do not echo raw responses or secrets',async()=>{
 const api=app(async()=>new Response('fake-test-key private payload',{status:403}));
 await assert.rejects(api.check(config('google')),e=>/访问被拒绝/.test(e.message)&&!e.message.includes('fake-test-key'));
});
test('network and timeout errors are explicit; no automatic retries',async()=>{
 let calls=0;const api=app(async()=>{calls++;throw new DOMException('secret','TimeoutError');});
 await assert.rejects(api.check(config('google')),/超时.*可能已计费/);assert.equal(calls,1);
});
