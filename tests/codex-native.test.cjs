const test=require('node:test');
const assert=require('node:assert/strict');
const {PassThrough}=require('node:stream');
const {serve}=require('../native/host.cjs');

test('native host accepts fragmented Chrome input and bounds each outgoing image frame',async()=>{
  const input=new PassThrough(),output=new PassThrough();
  const chunks=[];
  output.on('data',chunk=>chunks.push(chunk));
  const image='A'.repeat(1250000);
  let count=0;
  const serving=serve(input,output,async req=>{
    assert.deepEqual(req,{type:'generate',confirmed:true});
    count++;
    return {image,model:'mock'};
  });
  const body=Buffer.from(JSON.stringify({type:'generate',confirmed:true}));
  const header=Buffer.alloc(4);header.writeUInt32LE(body.length);
  input.write(header.subarray(0,1));input.write(header.subarray(1));input.write(body.subarray(0,2));input.write(body.subarray(2));
  await serving;
  input.end();output.end();
  const data=Buffer.concat(chunks);
  let collected='',pos=0,receipt;
  while(pos<data.length){
    const size=data.readUInt32LE(pos);assert.ok(size<1024*1024);
    const msg=JSON.parse(data.toString('utf8',pos+4,pos+4+size));
    if(msg.chunk)collected+=msg.chunk;else receipt=msg.done;
    pos+=size+4;
  }
  assert.equal(count,1);assert.equal(collected,image);assert.deepEqual(receipt,{model:'mock'});
});

test('native disconnect aborts the in-flight operation',async()=>{
  const input=new PassThrough(),output=new PassThrough();
  let aborted=false;
  const serving=serve(input,output,async(_request,signal)=>{
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    aborted=true;throw Error('cancelled');
  });
  input.end(Buffer.from([2,0,0,0,123,125]));
  await serving;
  assert.equal(aborted,true);assert.equal(output.readableLength,0);
});

test('large prints preserve aspect ratio at a 640 pixel long edge', {skip:process.platform!=='darwin'}, async t=>{
  const fs=require('node:fs/promises');
  const path=require('node:path');
  const os=require('node:os');
  const {execFileSync}=require('node:child_process');
  const {preparePrint}=require('../native/operation.cjs');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pc-print-size-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const source=path.join(dir,'wide.png');
  execFileSync('/usr/bin/sips',['-z','400','800',path.join(__dirname,'fixtures/artwork.png'),'--out',source]);
  const image=await preparePrint(dir,{outputImage:'wide.png',width:800,height:400});
  assert.ok(image.startsWith('data:image/jpeg;base64,'));
  const output=path.join(dir,'received.jpg');
  await fs.writeFile(output,Buffer.from(image.split(',')[1],'base64'));
  const info=execFileSync('/usr/bin/sips',['-g','pixelWidth','-g','pixelHeight',output],{encoding:'utf8'});
  assert.match(info,/pixelWidth: 640\b/);
  assert.match(info,/pixelHeight: 320\b/);
});
