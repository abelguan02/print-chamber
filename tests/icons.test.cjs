const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const manifest=require('../extension/manifest.json');
// PNG width/height live at fixed offsets in the IHDR chunk.
const size=file=>{const b=fs.readFileSync(path.join(root,'extension',file));assert.equal(b.toString('latin1',1,4),'PNG');return [b.readUInt32BE(16),b.readUInt32BE(20)];};
test('manifest icons exist at their declared sizes',()=>{
 for(const [px,file] of [...Object.entries(manifest.icons),...Object.entries(manifest.action.default_icon)])assert.deepEqual(size(file),[Number(px),Number(px)],file);
});
test('helper icon and About page use the unified icon source',()=>{
 assert.ok(fs.statSync(path.join(root,'menu-helper/AppIcon.icns')).size>0);
 assert.match(fs.readFileSync(path.join(root,'menu-helper/build.py'),'utf8'),/CFBundleIconFile='AppIcon'/);
 assert.match(fs.readFileSync(path.join(root,'extension/about.html'),'utf8'),/<img class="app-icon" src="icons\/icon\.svg"/);
});
