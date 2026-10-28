// Provider contracts: see CLOUD.md. No keys are stored in this module.
globalThis.Cloud = (() => {
  const providers = {
    'minimax-cn': {name:'MiniMax · 中国大陆（效果未验证）', models:['image-01'], base:'https://api.minimax.cn/v1', notice:'人物参考生成，效果未验证：可能改变原画构图、姿势、服饰或背景。即使生成成功，也不代表设计还原效果通过。'},
    minimax: {name:'MiniMax · 海外（效果未验证）', models:['image-01'], base:'https://api.minimax.io/v1', notice:'人物参考生成，效果未验证：可能改变原画构图、姿势、服饰或背景。即使生成成功，也不代表设计还原效果通过。'},
    bfl: {name:'Black Forest Labs · FLUX', models:['flux-2-klein-4b','flux-2-klein-9b','flux-2-pro','flux-2-max'], base:'https://api.bfl.ai/v1'},
    volc: {name:'火山方舟 · Seedream', models:['doubao-seedream-5-0-flash-260915','doubao-seedream-5-0-lite-260128'], base:'https://ark.cn-beijing.volces.com/api/v3'},
    ali: {name:'阿里云百炼 · 千问图像', models:['qwen-image-2.0-pro','qwen-image-2.0']},
    google: {name:'Google · Gemini', models:['gemini-nano-banana-2.1','gemini-3.1-flash-image'], base:'https://generativelanguage.googleapis.com/v1beta'}
  };
  function validate(c) {
    if (!c || !Object.hasOwn(providers,c.provider) || !providers[c.provider].models.includes(c.model)) throw Error('请选择支持图片编辑的供应商和模型');
    if (typeof c.key!=='string' || !c.key.trim() || c.key.length>1024 || /[\r\n]/.test(c.key)) throw Error('请填写有效 API Key');
    if(c.provider==='ali' && (!/^[a-zA-Z0-9-]{1,80}$/.test(c.workspace||'') || !['cn-beijing','ap-southeast-1'].includes(c.region))) throw Error('请填写百炼工作空间 ID 并选择密钥所属地区');
    return c;
  }
  function base(c) {return c.provider==='ali'?`https://${c.workspace}.${c.region}.maas.aliyuncs.com`:providers[c.provider].base;}
  function headers(c) {return {'Content-Type':'application/json',...(c.provider==='google'?{'x-goog-api-key':c.key}:c.provider==='bfl'?{'x-key':c.key}:{Authorization:'Bearer '+c.key})};}
  function failure(status) {
    return ({401:'密钥无效或已过期',403:'访问被拒绝：请检查模型权限、地区与账户限制',402:'账户额度不足',429:'请求受限：请检查余额或稍后再试',400:'供应商拒绝请求：请检查模型、图片和地区配置',404:'模型或接口不存在，请检查配置'})[status] || `供应商请求失败（HTTP ${status}）`;
  }
  async function request(url,options={},timeout=120000) {
    try {return await fetch(url,{...options,credentials:'omit',redirect:'error',signal:AbortSignal.timeout(timeout)});}
    catch(e) {throw Error(e.name==='TimeoutError'?'云端等待超时；请求可能已计费，请勿立即重复提交':'无法连接供应商：请检查网络及地区可用性');}
  }
  async function json(response) {
    if(!response.ok) throw Error(failure(response.status));
    // Bound streamed bodies even when the server omits Content-Length.
    const blob=await readBody(response,24000000);
    try {return JSON.parse(await blob.text());} catch {throw Error('供应商返回的数据无法解析');}
  }
  async function readBody(response,limit) {
    const reader=response.body.getReader(),parts=[];let size=0;
    try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw Error('供应商返回的文件过大');}parts.push(value);}}
    finally{reader.releaseLock();}
    return new Blob(parts,{type:response.headers.get('content-type')||'application/octet-stream'});
  }
  async function check(c) {
    validate(c);
    const google=c.provider==='google';
    const url=base(c)+(google?'/models/'+encodeURIComponent(c.model):c.provider.startsWith('minimax')?'/image_generation':c.provider==='bfl'?'/'+c.model:c.provider==='ali'?'/api/v1/services/aigc/multimodal-generation/generation':'/images/generations');
    const r=await request(url,{method:'GET',...(google?{headers:headers(c)}:{})},12000);
    if(google){await json(r);return {authenticated:true,message:'连接及模型查询通过；实际图片生成尚未验证'};}
    // GET cannot generate an image. No undocumented POST/auth probe is used.
    await r.body?.cancel();
    if(![200,401,403,404,405].includes(r.status))throw Error(failure(r.status));
    return {authenticated:false,message:`接口可达（HTTP ${r.status}）；密钥与生成能力未验证，请使用“试生成一张”`};
  }
  function build(c,image,prompt,aspect='1:1') {
    validate(c);
    if(!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image) || image.length>14000000)throw Error('参考图格式无效或过大');
    if(c.provider.startsWith('minimax'))return {url:base(c)+'/image_generation',body:{model:c.model,prompt,subject_reference:[{type:'character',image_file:image}],aspect_ratio:aspect,n:1,response_format:'base64',prompt_optimizer:false}};
    if(c.provider==='bfl')return {url:base(c)+'/'+c.model,body:{prompt,input_image:image.split(',')[1],output_format:'jpeg'}};
    if(c.provider==='volc')return {url:base(c)+'/images/generations',body:{model:c.model,prompt,image,size:'2K',response_format:'b64_json',sequential_image_generation:'disabled',watermark:true}};
    if(c.provider==='ali')return {url:base(c)+'/api/v1/services/aigc/multimodal-generation/generation',body:{model:c.model,input:{messages:[{role:'user',content:[{image},{text:prompt}]}]},parameters:{n:1,prompt_extend:false}}};
    return {url:base(c)+'/interactions',body:{model:c.model,input:[{type:'image',mime_type:image.slice(5,image.indexOf(';')),data:image.split(',')[1]},{type:'text',text:prompt}],response_format:{type:'image',image_size:'1K',aspect_ratio:aspect},store:false}};
  }
  function extract(c,data) {
    if(c.provider.startsWith('minimax')){
      const code=data.base_resp?.status_code;
      if(code!==0)throw Error('MiniMax 生成失败'+(Number.isInteger(code)?`（错误码 ${code}）`:'：响应缺少成功状态'));
      const image=data.data?.image_base64?.[0];
      return typeof image==='string'&&image?'data:image/jpeg;base64,'+image:null;
    }
    if(c.provider==='bfl')return data.result?.sample;
    if(c.provider==='volc'){const item=data.data?.[0];return item?.b64_json?'data:image/'+(item.output_format||'jpeg')+';base64,'+item.b64_json:null;}
    if(c.provider==='ali')return data.output?.choices?.[0]?.message?.content?.find(p=>p.image)?.image;
    const block=data.output_image || data.steps?.filter(s=>s.type==='model_output').flatMap(s=>s.content||[]).find(p=>p.type==='image'&&p.data);
    return block?.data?`data:${block.mime_type||'image/png'};base64,${block.data}`:null;
  }
  function bflURL(value,delivery=false){
    let url;try{url=new URL(value);}catch{throw Error('FLUX 返回的地址无效');}
    const host=delivery?(/^delivery\.[a-z0-9.-]+\.bfl\.ai$/.test(url.hostname)||url.hostname==='bfldeliveryprod.blob.core.windows.net'):/^api(?:\.[a-z0-9-]+)*\.bfl\.ai$/.test(url.hostname);
    if(url.protocol!=='https:'||url.username||url.password||url.port||!host||(!delivery&&url.pathname!=='/v1/get_result'))throw Error('FLUX 返回了不受信任的地址');
    return url.href;
  }
  async function poll(c,data,deadline){
    const url=bflURL(data.polling_url);
    while(Date.now()<deadline){
      const r=await json(await request(url,{method:'GET',headers:headers(c)},Math.min(12000,Math.max(1,deadline-Date.now()))));
      if(r.status==='Ready')return r;
      if(['Error','Failed','Request Moderated','Content Moderated'].includes(r.status))throw Error('FLUX 生成失败或被内容规则拦截');
      if(!['Pending','Processing','Running'].includes(r.status))throw Error('FLUX 返回了未知任务状态');
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    throw Error('FLUX 等待超时；任务可能仍在运行并计费，请勿立即重复提交');
  }
  async function toData(blob) {
    const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';
    for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return `data:${blob.type};base64,${btoa(binary)}`;
  }
  async function prepare(blob,max=1536,dimensions) {
    if(blob.size>12000000)throw Error('图片文件过大');
    let bitmap;try{bitmap=await createImageBitmap(blob);}catch{throw Error('图片无法解码');}
    try {
      if(bitmap.width*bitmap.height>24000000)throw Error('图片像素过多');
      if(dimensions){dimensions.width=bitmap.width;dimensions.height=bitmap.height;}
      const scale=Math.min(1,max/Math.max(bitmap.width,bitmap.height));
      const canvas=new OffscreenCanvas(Math.max(1,Math.round(bitmap.width*scale)),Math.max(1,Math.round(bitmap.height*scale)));
      const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
      return toData(await canvas.convertToBlob({type:'image/jpeg',quality:.9}));
    } finally {bitmap.close();}
  }
  async function generate(c,blob,prompt) {
    const start=Date.now(),dimensions={},image=await prepare(blob,1536,dimensions);
    const ratios=['1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9'].filter(r=>!c.provider.startsWith('minimax')||!['4:5','5:4'].includes(r));
    const distance=r=>{const [w,h]=r.split(':').map(Number);return Math.abs(Math.log((w/h)/(dimensions.width/dimensions.height)));};
    const aspect=ratios.reduce((a,b)=>distance(a)<distance(b)?a:b);
    const req=build(c,image,prompt,aspect);
    let data=await json(await request(req.url,{method:'POST',headers:headers(c),body:JSON.stringify(req.body)}));
    if(c.provider==='bfl')data=await poll(c,data,Date.now()+120000);
    const result=extract(c,data);if(!result)throw Error('供应商未返回图片，可能被内容规则拦截或模型未完成生成');
    let output;
    if(result.startsWith('data:image/')&&result.length<=24000000){
      if(!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(result))throw Error('供应商图片格式无效');
      output=await (await fetch(result)).blob();
    }else{
      const url=new URL(result);
      if(c.provider==='bfl')bflURL(result,true);
      else if(c.provider!=='ali'||url.protocol!=='https:'||url.username||url.password||url.port||!url.hostname.endsWith('.aliyuncs.com'))throw Error('供应商返回了不支持的图片地址');
      const r=await request(url.href,{},30000);if(!r.ok)throw Error('生成成功，但结果下载失败');output=await readBody(r,16000000);
    }
    return {image:await prepare(output,1280),seconds:(Date.now()-start)/1000,provider:c.provider,model:c.model};
  }
  return {providers,validate,check,build,extract,generate,prepare,bflURL,poll};
})();
