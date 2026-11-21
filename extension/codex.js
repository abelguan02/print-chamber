// A native port keeps the MV3 worker alive until this single operation ends.
function codexRequest(request) {
  return new Promise((resolve,reject)=>{
    const port=chrome.runtime.connectNative('com.printchamber.codex');
    const chunks=[];
    let size=0,finished=false;
    const timer=setTimeout(()=>finish(null,'本机 Codex 等待超时，操作已停止'),request.type==='connect'?30000:360000);
    function finish(result,error){
      if(finished)return;
      finished=true; clearTimeout(timer); port.disconnect();
      if(error)reject(Error(error));else resolve(result);
    }
    port.onDisconnect.addListener(()=>{
      const reason=chrome.runtime.lastError?.message||'';
      finish(null,/not found|forbidden|not registered/i.test(reason)?'Chrome 找不到匹配的 Print Chamber 本机助手，请先登记助手并加载对应的扩展目录。':'本机 Codex 连接已中断，请重新连接。');
    });
    port.onMessage.addListener(msg=>{
      if(typeof msg.error==='string')return finish(null,msg.error);
      if(request.type==='generate' && typeof msg.chunk==='string'){
        size+=msg.chunk.length;
        if(size>22000000)return finish(null,'Codex 返回的图片过大');
        chunks.push(msg.chunk);return;
      }
      if(request.type==='connect'&&msg.done?.connected===true)return finish({connected:true});
      if(request.type==='generate'&&msg.done&&size)return finish({...msg.done,image:chunks.join('')});
      finish(null,'本机助手返回了无效结果');
    });
    try {port.postMessage(request);}catch {finish(null,'无法向本机助手发送请求');}
  });
}
async function codexGenerate(blob) {
  const bytes=new Uint8Array(await blob.arrayBuffer());
  let binary='';
  for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  const result=await codexRequest({type:'generate',confirmed:true,data:'data:'+blob.type+';base64,'+btoa(binary)});
  const output=await (await fetch(result.image)).blob();
  return {...result,image:await Cloud.prepare(output,1280)};
}
