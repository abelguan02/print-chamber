'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {AppServerClient} = require('./codex/client.cjs');
const {findCodex} = require('./codex/discovery.cjs');
const {isolateDesktopImage} = require('./codex/isolation.cjs');
const {SERVER_ARGS, initialize, checkAccount, imageModel, startImageThread, printTurn} = require('./codex/session.cjs');
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
  if (!generate && !['detect','connect','check-session'].includes(request.type)) throw Error('不支持的 Codex 操作');
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'print-chamber-codex-')));
  let client, listener;
  const close = () => client?.close();
  try {
    const base = {HOME:os.homedir(), PATH:'/usr/bin:/bin', TMPDIR:temp, CODEX_SQLITE_HOME:temp};
    if (process.env.CODEX_HOME) base.CODEX_HOME = process.env.CODEX_HOME;
    signal.addEventListener('abort',close,{once:true});
    const detected = await findCodex(async cli=>{
      signal.throwIfAborted();
      const env=await isolateDesktopImage(temp,base,cli);
      const {stdout}=await execFileAsync('codex',['--version'],{cwd:temp,env,timeout:5000,signal});
      const version=stdout.trim();
      if (!/^codex(?:-cli)? [0-9][0-9A-Za-z.+-]*$/.test(version)) throw Error('无效的 Codex 版本');
      if (request.type!=='detect') {
        signal.throwIfAborted();
        client=new AppServerClient({cwd:temp,env,args:SERVER_ARGS,onNotification:(method,params)=>listener?.(method,params)});
        try {await initialize(client);} catch (error) {await close();client=null;signal.throwIfAborted();throw error;}
      }
      return {version};
    });
    signal.throwIfAborted();
    if (request.type==='detect') return detected;
    if (!detected.found) throw Error('未找到可启动的 Codex');
    await checkAccount(client);
    if (request.type==='connect') return {connected:true,source:detected.source,version:detected.version};
    const model=await imageModel(client);
    if (request.type==='check-session') {
      const start=performance.now();
      await startImageThread(client,temp,model);
      return {sessionReady:true,threadStartMs:Math.round(performance.now()-start)};
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
    const threadId=await startImageThread(client,temp,model);
    const record=await printTurn({client,threadId,listen:fn=>{listener=fn;},prompt:globalThis.CLOUD_PROMPT,
      temp,inputPath,sourceSha:createHash('sha256').update(bytes).digest('hex')});
    await client.close();
    const image = await preparePrint(temp, record);
    return {image,seconds:record.seconds,provider:'codex',model};
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
