const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn,execFileSync} = require('node:child_process');
const {once} = require('node:events');
const {mkdtemp,readFile,writeFile,rm,access} = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {createHash,createPublicKey} = require('node:crypto');
const {id, origin, name} = require('../native/identity.cjs');
const manifest = require('../extension/manifest.json');
const host = require.resolve('../native/host.cjs');

function request(args, message, env) {
  const child = spawn(process.execPath,[host,...args],{env,stdio:['pipe','pipe','pipe']});
  const output = [];
  child.stdout.on('data', chunk => {
    output.push(chunk);
    const data = Buffer.concat(output);
    if (data.length>=4 && data.length>=4+data.readUInt32LE()) child.stdin.end();
  });
  child.stdin.on('error', error => { if(error.code!=='EPIPE') throw error; });
  const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  child.stdin.write(Buffer.concat([header,body]));
  return once(child,'close').then(([code]) => {
    const data = Buffer.concat(output);
    return {code, reply:data.length?JSON.parse(data.subarray(4)):null};
  });
}
async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(),'pc-pairing-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  return {home,state:path.join(home,'Library/Application Support/Print Chamber'),
          env:{HOME:home,PATH:'/usr/bin:/bin',PRINT_CHAMBER_MODE:'app'}};
}
test('fixed Chrome ID matches the public RSA-2048 key',()=>{
  const der=Buffer.from(manifest.key,'base64');
  const key=createPublicKey({key:der,format:'der',type:'spki'});
  assert.equal(key.asymmetricKeyType,'rsa');assert.equal(key.asymmetricKeyDetails.modulusLength,2048);
  const derived=createHash('sha256').update(der).digest('hex').slice(0,32).replace(/./g,n=>'abcdefghijklmnop'[parseInt(n,16)]);
  assert.equal(id,derived);
});
test('host rejects both pairing requests from other origins before reading or writing state',async t=>{
  const {env,state}=await fixture(t);
  for(const type of ['hello','local-token']){
    for(const args of [[],['chrome-extension://'+'a'.repeat(32)+'/'],[origin,'other']]){
      assert.deepEqual(await request(args,{type,version:'1.2'},env),{code:1,reply:null});
    }
  }
  await assert.rejects(access(state),{code:'ENOENT'});
});
test('hello records the running version, while local-token handles absent and rotated fixture codes',async t=>{
  const {env,state}=await fixture(t);
  const send=async msg=>(await request([origin],msg,env)).reply;
  assert.deepEqual(await send({type:'local-token'}),{done:{token:null}});
  assert.deepEqual(await send({type:'hello',version:'0.1.2'}),{done:{appVersion:manifest.version,extensionVersion:manifest.version}});
  const seen=JSON.parse(await readFile(path.join(state,'extension-seen.json'),'utf8'));
  assert.equal(seen.version,'0.1.2');assert.ok(Number.isFinite(Date.parse(seen.time)));
  for(const token of ['fixture-first','fixture-second']){
    await writeFile(path.join(state,'token'),token+'\n');
    assert.deepEqual(await send({type:'local-token'}),{done:{token}});
  }
  assert.ok((await send({type:'hello',version:'invalid'})).error);
  assert.deepEqual(JSON.parse(await readFile(path.join(state,'extension-seen.json'),'utf8')),seen);
});
test('development registration in a temporary HOME accepts only the fixed ID', {skip:process.platform!=='darwin'},async t=>{
  const {home,env}=await fixture(t);
  execFileSync(process.execPath,[require.resolve('../native/install.cjs')],{env});
  const file=path.join(home,'Library/Application Support/Google/Chrome/NativeMessagingHosts',name+'.json');
  const registration=JSON.parse(await readFile(file,'utf8'));
  assert.deepEqual(registration.allowed_origins,[origin]);assert.equal(registration.name,name);
  await access(registration.path,require('node:fs').constants.X_OK);
});
