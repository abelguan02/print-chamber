// ZIP with stored entries: JPEGs are already compressed. No library or download permission needed.
const crcTable=Uint32Array.from({length:256},(_,value)=>{
  for(let bit=0;bit<8;bit++)value=(value&1)?0xedb88320^(value>>>1):value>>>1;
  return value>>>0;
});
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0}
function header(size){const bytes=new Uint8Array(size);return {bytes,view:new DataView(bytes.buffer)}}
export function printArchive(records){
  const encoder=new TextEncoder(),files=[],directory=[];let offset=0,directorySize=0;
  records.forEach((record,index)=>{
    const match=/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(record.image);
    if(!match)throw new Error('部分图片无法下载，请重新打印后再试');
    const bytes=Uint8Array.from(atob(match[2]),char=>char.charCodeAt(0));
    const name=encoder.encode(`print-${String(index+1).padStart(3,'0')}.${match[1]==='jpeg'?'jpg':match[1]}`);
    const crc=crc32(bytes),local=header(30),central=header(46);
    local.view.setUint32(0,0x04034b50,true);local.view.setUint16(4,20,true);local.view.setUint16(6,0x800,true);
    local.view.setUint16(12,33,true); // 1980-01-01, deterministic ZIP timestamp.
    local.view.setUint32(14,crc,true);local.view.setUint32(18,bytes.length,true);local.view.setUint32(22,bytes.length,true);local.view.setUint16(26,name.length,true);
    central.view.setUint32(0,0x02014b50,true);central.view.setUint16(4,20,true);central.view.setUint16(6,20,true);central.view.setUint16(8,0x800,true);central.view.setUint16(14,33,true);
    central.view.setUint32(16,crc,true);central.view.setUint32(20,bytes.length,true);central.view.setUint32(24,bytes.length,true);central.view.setUint16(28,name.length,true);central.view.setUint32(42,offset,true);
    files.push(local.bytes,name,bytes);directory.push(central.bytes,name);offset+=30+name.length+bytes.length;directorySize+=46+name.length;
  });
  const end=header(22);end.view.setUint32(0,0x06054b50,true);end.view.setUint16(8,records.length,true);end.view.setUint16(10,records.length,true);end.view.setUint32(12,directorySize,true);end.view.setUint32(16,offset,true);
  return new Blob([...files,...directory,end.bytes],{type:'application/zip'});
}
