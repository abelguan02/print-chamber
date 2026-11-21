'use strict';
const {once} = require('node:events');
const {operate} = require('./operation.cjs');

// Each port carries one request. Chrome's stdout limit is 1 MiB per frame.
async function serve(input,output,run=operate) {
  const abort = new AbortController();
  let header=Buffer.alloc(4), headerSize=0, body, size=0, dispatched=false;
  const cancel=()=>abort.abort();
  input.once('end',cancel);
  input.once('error',cancel);
  output.once('error',cancel);
  async function send(value) {
    const json=Buffer.from(JSON.stringify(value));
    const frame=Buffer.alloc(4+json.length);
    frame.writeUInt32LE(json.length);
    json.copy(frame,4);
    if(!output.write(frame)) await once(output,'drain',{signal:abort.signal});
  }
  return new Promise(resolve=>{
    async function dispatch(message) {
      try {
        const result=await run(message,abort.signal);
        if(abort.signal.aborted)return;
        if(result.image) {
          const {image,...metadata}=result;
          for(let pos=0;pos<image.length;pos+=512000) await send({chunk:image.slice(pos,pos+512000)});
          await send({done:metadata});
        } else await send({done:result});
      } catch(error) {
        if(!abort.signal.aborted)await send({error:error.message}).catch(()=>{});
      } finally { resolve(); }
    }
    input.on('data',chunk=>{
      if(abort.signal.aborted)return;
      if(dispatched){cancel();return;}
      if(!body){
        const n=Math.min(4-headerSize,chunk.length);
        chunk.copy(header,headerSize,0,n); headerSize+=n; chunk=chunk.subarray(n);
        if(headerSize<4)return;
        const length=header.readUInt32LE();
        if(!length||length>16000200){cancel();resolve();return;}
        body=Buffer.alloc(length);
      }
      if(size+chunk.length>body.length){cancel();resolve();return;}
      chunk.copy(body,size); size+=chunk.length;
      if(size===body.length){
        dispatched=true;
        let request;
        try { request=JSON.parse(body.toString()); } catch {resolve();return;}
        void dispatch(request);
      }
    });
    input.once('end',()=>{if(!dispatched)resolve();});
  });
}
if(require.main===module){
  const [expected,origin]=process.argv.slice(2);
  if(!/^chrome-extension:\/\/[a-p]{32}\/$/.test(expected)||expected!==origin)process.exitCode=1;
  else serve(process.stdin,process.stdout).finally(()=>process.stdin.destroy());
}
module.exports={serve};
