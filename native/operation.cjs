'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {AppServerClient} = require('../experiments/codex-imagegen/client.cjs');
const {findDesktopCli} = require('../experiments/codex-imagegen/desktop-cli.cjs');
const {isolateDesktopImage} = require('../experiments/codex-imagegen/isolation.cjs');
const {SERVER_ARGS, confirmChatgpt, preflight, startImageThread, runTurn} = require('../experiments/codex-imagegen/run.cjs');
require('../extension/cloud-prompt.js');

const execFileAsync = promisify(execFile);
const PRINT_LONG_EDGE = 640;

async function preparePrint(temp, {outputImage, width, height}) {
  const input = path.join(temp, outputImage);
  if (width * height > 24000000 || (await fs.stat(input)).size > 12000000) {
    throw Error('生成图片超过尺寸或文件大小限制');
  }
  const output = path.join(temp, 'print.jpg');
  const resize = Math.max(width, height) > PRINT_LONG_EDGE ? ['-Z', String(PRINT_LONG_EDGE)] : [];
  await execFileAsync('/usr/bin/sips', [...resize, '-s', 'format', 'jpeg', '-s', 'formatOptions', '90',
    input, '--out', output], {timeout:30000});
  return 'data:image/jpeg;base64,' + await fs.readFile(output, 'base64');
}

async function operate(request, signal) {
  const generate = request.type === 'generate' && request.confirmed === true;
  if (!generate && request.type !== 'connect' && request.type !== 'check-session') throw Error('不支持的 Codex 操作');
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
    if (request.type === 'connect') {
      await confirmChatgpt(client,checks,{});
      return {connected:true};
    }
    await preflight(client,checks,{});
    const model = 'gpt-6.2-sol';
    if (!checks.ready || checks.rateLimits?.ordinaryUsageAllowed !== true ||
        !checks.models?.some(m=>m.model===model && m.imageInput)) throw Error('本机 Codex 的模型、图片能力或可用额度未就绪');
    if (request.type === 'check-session') {
      const start = performance.now();
      await startImageThread(client, {cwd:temp, model, singleAttempt:true, directImage:true});
      return {sessionReady:true, threadStartMs:Math.round(performance.now()-start)};
    }
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
    const image = await preparePrint(temp, record);
    return {image, seconds:record.durationMs/1000, provider:'codex', model, timings:record.timings, receivedAt:record.receivedAt};
  } catch (error) {
    if (error.code === 'APP_SERVER_REQUEST_TIMEOUT' && error.method === 'thread/start') {
      throw Error(`Codex 创建会话超过 ${error.timeoutMs / 1000} 秒，已停止，原画未提交。`);
    }
    throw error;
  } finally {
    signal.removeEventListener('abort',close);
    try { await close(); } finally { await fs.rm(temp,{recursive:true,force:true}); }
  }
}
module.exports={operate,preparePrint};
