const test=require('node:test');
const assert=require('node:assert/strict');
const {findCodex}=require('../native/codex/discovery.cjs');
const {selectModel,printTurn,startImageThread,checkAccount}=require('../native/codex/session.cjs');

for(const [label,invalid,unstartable,expected,source] of [
  ['signed standalone',[],[], 'a','standalone'],
  ['skip an unsigned standalone',['a'],[], 'b','standalone'],
  ['desktop fallback',['a','b'],[], 'desktop','desktop'],
  ['same isolation rejects standalone',[],['a','b'], 'desktop','desktop'],
  ['no verified installation',['a','b','desktop'],[], null,null],
]){
  test('Codex discovery: '+label,async()=>{
    const inspected=[],reported=[];
    const result=await findCodex(async cli=>{
      assert.ok(!invalid.includes(cli));inspected.push(cli);
      if(unstartable.includes(cli))throw Error('mock isolation failure');
      return {version:'codex-cli 1.0'};
    },{
      standalone:['a','b'],desktop:['application'],resolve:async p=>p,bundleCli:async()=>'desktop',
      verify:async p=>{if(invalid.includes(p))throw Error('mock invalid signature');},
      report:message=>reported.push(message),
    });
    assert.deepEqual(result,{found:!!expected,source,version:expected?'codex-cli 1.0':null});
    if(expected)assert.equal(inspected.at(-1),expected);
    assert.equal(reported.length,invalid.length+unstartable.length);
  });
}

test('model/list prefers the image-capable default and otherwise the first image-capable model',()=>{
  const image={model:'fixture-image',inputModalities:['image']};
  const preferred={model:'fixture-default',isDefault:true,inputModalities:['text','image']};
  assert.equal(selectModel([image,preferred]),preferred.model);
  assert.equal(selectModel([{...preferred,inputModalities:['text']},image]),image.model);
  assert.throws(()=>selectModel([{...preferred,inputModalities:['text']}]),/当前 Codex 没有支持图片输入的模型/);
});

test('connect checks the existing account and reports an exhausted allowance without creating a thread',async()=>{
  const calls=[];
  const client={request:async method=>{
    calls.push(method);return method==='account/read'?{account:{type:'chatgpt'}}:{ordinaryUsageAllowed:false};
  }};
  await assert.rejects(checkAccount(client),/Codex 额度已用完/);
  assert.deepEqual(calls,['account/read','account/rateLimits/read']);
});

test('the production print accepts one matching tool result from a simulated app-server', {skip:process.platform!=='darwin'},async t=>{
  const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
  const {createHash}=require('node:crypto');
  require('../extension/cloud-prompt.js');
  const prompt=globalThis.CLOUD_PROMPT;
  assert.equal(createHash('sha256').update(prompt).digest('hex'),'c2b9255da22505c3e2895fc2fcdbb076167405bb45cb8c68dbba7457e2c01ccb');
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'pc-print-mock-'));
  t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const inputPath=path.join(temp,'reference.jpg'),sourceSha='a'.repeat(64),model='fixture-auto';
  const result=await fs.readFile(path.join(__dirname,'fixtures/artwork.png'),'base64');
  let notify;
  const calls=[];
  const client={disconnected:new Promise(()=>{}),request:async(method,params)=>{
    calls.push(method);
    if(method==='thread/start'){
      assert.equal(params.model,model);
      return {thread:{id:'T'},model,modelProvider:'openai',approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false}};
    }
    assert.equal(method,'turn/start');assert.equal(Object.hasOwn(params,'effort'),false);
    assert.ok(params.input[0].text.endsWith('\n\n'+prompt));
    assert.deepEqual(params.input[1],{type:'localImage',path:inputPath});
    notify('item/completed',{threadId:'T',turnId:'U',item:{type:'imageGeneration',status:'completed',result,inputImages:[{sha256:sourceSha}]}});
    return {turn:{id:'U'}};
  }};
  const threadId=await startImageThread(client,temp,model);
  const image=await printTurn({client,threadId,listen:fn=>{notify=fn;},temp,inputPath,sourceSha,prompt});
  assert.equal(image.referenceHashMatched,true);assert.equal(image.format,'PNG');
  assert.deepEqual(calls,['thread/start','turn/start']);
});
