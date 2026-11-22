'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {id, origin, name}=require('./identity.cjs');
const root=fs.realpathSync(path.join(__dirname,'..'));
const extension=path.join(root,'extension');
const support=path.join(os.homedir(),'Library/Application Support');
const dir=path.join(support,'Print Chamber','NativeMessaging');
const hosts=path.join(support,'Google/Chrome/NativeMessagingHosts');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
function install(){
  if(process.platform!=='darwin'||Number(process.versions.node.split('.')[0])<22)throw Error('需要 macOS 和 Node.js 22 或更新版本');
  const bundled=process.argv[2]==='--app';
  fs.mkdirSync(hosts,{recursive:true});
  const launcher=bundled ? path.resolve(root,'../MacOS/print-chamber-host') : path.join(dir,'codex-'+id);
  const tmp=fs.mkdtempSync(path.join(hosts,'.print-chamber-'));
  const hostFile=path.join(hosts,name+'.json');
  const tempManifest=path.join(tmp,'manifest.json');
  try {
    if(bundled) {
      // Chrome starts the host independently and does not inherit the app's state override.
      const selected=process.env.PRINT_CHAMBER_STATE;
      const binding=path.join(dir,'app-state.json');
      if(selected && path.resolve(selected)!==path.join(support,'Print Chamber')){
        fs.mkdirSync(dir,{recursive:true,mode:0o700});
        fs.writeFileSync(path.join(tmp,'state'),JSON.stringify({state:path.resolve(selected)}),{mode:0o600});
        fs.renameSync(path.join(tmp,'state'),binding);
      } else fs.rmSync(binding,{force:true});
    } else {
      fs.mkdirSync(dir,{recursive:true,mode:0o700});
      const state=process.env.PRINT_CHAMBER_STATE;
      const config=state?'export PRINT_CHAMBER_STATE='+quote(path.resolve(state))+'\n':'';
      fs.writeFileSync(path.join(tmp,'start'),'#!/bin/sh\n'+config+'exec '+[process.execPath,path.join(root,'native/host.cjs')].map(quote).join(' ')+' "$@"\n',{mode:0o700});
      fs.renameSync(path.join(tmp,'start'),launcher);
    }
    fs.accessSync(launcher, fs.constants.X_OK);
    fs.writeFileSync(tempManifest,JSON.stringify({name,description:'Print Chamber 本机 Codex',path:launcher,type:'stdio',allowed_origins:[origin]},null,2)+'\n',{flag:'wx',mode:0o600});
    fs.renameSync(tempManifest,hostFile);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
  if(!bundled)console.log('Chrome 本机助手已登记。加载扩展目录：'+extension+'\n扩展 ID：'+id);
}
if(require.main===module)install();
module.exports={id,origin,name};
