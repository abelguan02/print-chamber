'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const root=fs.realpathSync(path.join(__dirname,'..'));
const extension=path.join(root,'extension');
function extensionId(directory){
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  const identity=manifest.key?Buffer.from(manifest.key,'base64'):Buffer.from(fs.realpathSync(directory));
  return createHash('sha256').update(identity).digest('hex').slice(0,32)
    .replace(/./g,n=>String.fromCharCode(97+parseInt(n,16)));
}
const id=extensionId(extension);
const origin='chrome-extension://'+id+'/';
const name='com.printchamber.codex';
const support=path.join(os.homedir(),'Library/Application Support');
const dir=path.join(support,'Print Chamber','NativeMessaging');
const hosts=path.join(support,'Google/Chrome/NativeMessagingHosts');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
function install(){
  if(process.platform!=='darwin'||Number(process.versions.node.split('.')[0])<22)throw Error('需要 macOS 和 Node.js 22 或更新版本');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.mkdirSync(hosts,{recursive:true});
  const launcher=path.join(dir,'codex-'+id);
  const tmp=fs.mkdtempSync(path.join(dir,'install-'));
  const hostFile=path.join(hosts,name+'.json');
  const tempManifest=path.join(hosts,'.'+name+'-'+process.pid);
  try {
    fs.writeFileSync(path.join(tmp,'start'),'#!/bin/sh\nexec '+[process.execPath,path.join(root,'native/host.cjs'),origin].map(quote).join(' ')+' "$@"\n',{mode:0o700});
    fs.renameSync(path.join(tmp,'start'),launcher);
    fs.writeFileSync(tempManifest,JSON.stringify({name,description:'Print Chamber 本机 Codex',path:launcher,type:'stdio',allowed_origins:[origin]},null,2)+'\n',{flag:'wx',mode:0o600});
    fs.renameSync(tempManifest,hostFile);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});fs.rmSync(tempManifest,{force:true});}
  console.log('Chrome 本机助手已登记。加载扩展目录：'+extension+'\n扩展 ID：'+id);
}
if(require.main===module)install();
module.exports={id,origin,name,extensionId};
