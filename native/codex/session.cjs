'use strict';
const {version} = require('../../extension/manifest.json');
const {collectImage} = require('./image.cjs');

const SERVER_ARGS = [
  '-c','model_provider="openai"',
  '-c','features.code_mode={enabled=false,direct_only_tool_namespaces=["image_gen"]}',
  '-c','features.omit_app_server_notification_media=false', '-c','mcp_servers={}',
  '-c','web_search="disabled"', '-c','check_for_update_on_startup=false',
  ...['shell_tool','unified_exec','apps','plugins','hooks','multi_agent','multi_agent_v2',
    'computer_use','in_app_browser','shell_snapshot'].flatMap(name=>['-c','features.'+name+'=false']),
];

async function initialize(client) {
  await client.request('initialize',{clientInfo:{name:'print-chamber',title:'Print Chamber',version}});
  client.notify('initialized');
}

async function list(client, method) {
  const items = [], cursors = new Set();
  let cursor = null;
  do {
    const response = await client.request(method,{cursor,limit:100});
    items.push(...response.data);
    cursor = response.nextCursor;
    if (cursor && cursors.has(cursor)) throw Error(method+' 返回重复分页');
    cursors.add(cursor);
  } while (cursor);
  return items;
}

function selectModel(models) {
  const supported = models.filter(m => m.inputModalities === undefined || m.inputModalities?.includes('image'));
  const selected = supported.find(m=>m.isDefault) ?? supported[0];
  if (!selected) throw Error('当前 Codex 没有支持图片输入的模型');
  return selected.model;
}

async function checkAccount(client) {
  const {account} = await client.request('account/read',{refreshToken:false});
  if (account?.type !== 'chatgpt') throw Error('未登录 Codex');
  const {ordinaryUsageAllowed,rateLimits,rateLimitsByLimitId} = await client.request('account/rateLimits/read',{});
  const quota = rateLimitsByLimitId?.codex ?? (rateLimits?.limitId === 'codex' ? rateLimits : null);
  if (ordinaryUsageAllowed === false || quota?.rateLimitReachedType || quota?.spendControlReached) throw Error('Codex 额度已用完');
  if (ordinaryUsageAllowed !== true) throw Error('无法确认 Codex 可用额度');
}

async function imageModel(client) {
  const [features,provider,models] = await Promise.all([list(client,'experimentalFeature/list'),
    client.request('modelProvider/capabilities/read',{}), list(client,'model/list')]);
  if (!features.some(f=>f.name==='image_generation' && f.enabled) || !provider.imageGeneration) throw Error('Codex 出图不可用');
  return selectModel(models);
}

async function startImageThread(client,cwd,model) {
  const thread = await client.request('thread/start',{
    cwd, sandbox:'read-only', approvalPolicy:'never', ephemeral:true, modelProvider:'openai', model,
    developerInstructions:'Call image_gen.imagegen directly, exactly once. Pass the attached original’s absolute path in referenced_image_paths and the supplied G3 text as the prompt. Stop on success or failure. Do not retry or use other tools.',
  },90000);
  if (thread.approvalPolicy!=='never' || thread.sandbox?.type!=='readOnly' || thread.sandbox.networkAccess===true ||
      thread.modelProvider!=='openai' || thread.model!==model || !thread.thread?.id) throw Error('Codex 会话配置不匹配');
  return thread.thread.id;
}

// Accept only the submitted turn. A notification can arrive before its RPC reply.
async function printTurn({client, threadId, listen, inputPath, temp, sourceSha, prompt}) {
  let turnId, timer, finish, ended=false, observedImage=false;
  let completedItem, candidateImage;
  const complete = new Promise(resolve=>{finish=resolve;});
  listen((method,params)=>{
    if (ended || params?.threadId!==threadId) return;
    const id=params.turn?.id ?? params.turnId;
    if (!id || (turnId && id!==turnId)) return;
    turnId=id;
    if (params.item?.type==='imageGeneration') observedImage=true;
    if (method==='item/completed' && params.item?.type==='imageGeneration') {
      completedItem=params.item;
      if (completedItem.failure || completedItem.status==='failed') {
        ended=true; finish({item:completedItem});
      } else if (completedItem.result || completedItem.savedPath) {
        candidateImage=collectImage(completedItem,temp,temp,1,sourceSha);
        if (candidateImage.outputImage) {
          ended=true; finish({item:completedItem,image:candidateImage});
        }
      }
    } else if (method==='turn/completed') {
      ended=true;
      const finalItem=params.turn.items?.find(i=>i.type==='imageGeneration' && (!completedItem?.id || i.id===completedItem.id));
      const item=finalItem ? {...completedItem,...finalItem} : completedItem;
      finish({item,image:finalItem ? undefined : candidateImage,error:params.turn.error?.codexErrorInfo});
    }
  });
  const start=performance.now();
  try {
    const submitted=client.request('turn/start',{threadId,input:[
      {type:'text',text:'Use image_gen.imagegen with referenced_image_paths='+JSON.stringify([inputPath])+'. Follow this exact G3 prompt:\n\n'+prompt},
      {type:'localImage',path:inputPath},
    ]},301000).then(reply=>{
      if(turnId && turnId!==reply.turn.id)throw Error('Codex 返回了不同的会话轮次');
      turnId=reply.turn.id;
    });
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Codex 打印超时')),300000);});
    const [,result]=await Promise.race([Promise.all([submitted,complete]),deadline,client.disconnected.then(e=>{throw e;})]);
    const seconds=(performance.now()-start)/1000;
    if(result.error==='usageLimitExceeded' || result.item?.failure?.type==='usageLimitExceeded')throw Error('Codex 额度已用完');
    if(!result.item)throw Error(observedImage?'图片工具未返回有效图片':'未收到图片工具调用');
    const image=result.image ?? collectImage(result.item,temp,temp,1,sourceSha);
    if(!image.outputImage || image.referenceHashMatched===false)throw Error(image.error || '参考原画不匹配');
    return {...image,seconds};
  } finally {
    clearTimeout(timer);
    listen(null);
    if (!ended && turnId) await client.request('turn/interrupt',{threadId,turnId},3000).catch(()=>client.close());
  }
}

module.exports={SERVER_ARGS,initialize,checkAccount,imageModel,selectModel,startImageThread,printTurn};
