'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {AppServerClient} = require('../experiments/codex-imagegen/client.cjs');
const {findDesktopCli} = require('../experiments/codex-imagegen/desktop-cli.cjs');
const {isolateDesktopImage} = require('../experiments/codex-imagegen/isolation.cjs');
const {SERVER_ARGS, confirmChatgpt, preflight, runTurn} = require('../experiments/codex-imagegen/run.cjs');
require('../extension/cloud-prompt.js');

async function operate(request, signal) {
  const generate = request.type === 'generate' && request.confirmed === true;
  if (!generate && request.type !== 'connect') throw Error('不支持的 Codex 操作');
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'print-chamber-codex-')));
  let client, listener;
  const close = () => client?.close();
  try {
    const base = {HOME:os.homedir(), PATH:'/usr/bin:/bin', TMPDIR:temp, CODEX_SQLITE_HOME:temp};
    if (process.env.CODEX_HOME) base.CODEX_HOME = process.env.CODEX_HOME;
    const env = await isolateDesktopImage(temp,base,await findDesktopCli());
    const args = SERVER_ARGS.map(s => s === 'features.code_mode=false'
      ? 'features.code_mode={enabled=false,direct_only_tool_namespaces=["image_gen"]}' : s);
    args.push('-c','features.omit_app_server_notification_media=false');
    signal.throwIfAborted();
    client = new AppServerClient({cwd:temp,env,args,onNotification:(method,params)=>listener?.(method,params)});
    signal.addEventListener('abort',close,{once:true});
    const checks = {issues:{}};
    if (!generate) {
      await confirmChatgpt(client,checks,{});
      return {connected:true};
    }
    await preflight(client,checks,{});
    const model = 'gpt-6.2-sol';
    if (!checks.ready || checks.rateLimits?.ordinaryUsageAllowed !== true ||
        !checks.models?.some(m=>m.model===model && m.imageInput)) throw Error('本机 Codex 的模型、图片能力或可用额度未就绪');
    const {data} = request;
    if (typeof data!=='string'||data.length>16000040) throw Error('原画超过 12 MB');
    const comma=data.indexOf(',');
    const ext={'data:image/jpeg;base64':'jpg','data:image/png;base64':'png','data:image/webp;base64':'webp'}[data.slice(0,comma)];
    if (typeof ext!=='string') throw Error('不支持的原画格式');
    const bytes=Buffer.from(data.slice(comma+1),'base64');
    if (!bytes.length||bytes.length>12000000||bytes.toString('base64')!==data.slice(comma+1)) throw Error('原画数据无效');
    const inputPath=path.join(temp,'reference.'+ext);
    await fs.writeFile(inputPath,bytes);
    const source={id:1,sha256:createHash('sha256').update(bytes).digest('hex')};
    const record={firstEventMs:null};
    await runTurn({client,listen:fn=>{listener=fn;},record,source,prompt:globalThis.CLOUD_PROMPT,
      model,tempRoot:temp,cwd:temp,outputDir:temp,inputPath,singleAttempt:true,directImage:true});
    await client.close();
    const file=path.join(temp,record.outputImage);
    if ((await fs.stat(file)).size>16000000) throw Error('生成结果超过 16 MB');
    const image=await fs.readFile(file,'base64');
    return {image:'data:image/'+record.format.toLowerCase()+';base64,'+image,seconds:record.durationMs/1000,provider:'codex',model};
  } finally {
    signal.removeEventListener('abort',close);
    try { await close(); } finally { await fs.rm(temp,{recursive:true,force:true}); }
  }
}
module.exports={operate};
