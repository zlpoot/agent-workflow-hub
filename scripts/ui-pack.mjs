import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Small deterministic uncompressed ZIP; only the closed browser asset set ships.
const root=dirname(dirname(fileURLToPath(import.meta.url))),args=process.argv.slice(2);
assert(args.length===0 || args.length===2 && args[0]==='--output','Use only --output <directory>');
const output=resolve(args[1] ?? join(root,'.handoff/packages'));mkdirSync(output,{recursive:true});
const names=['index.html','app.js','app.css','validators.cjs'],chunks=[],central=[];let offset=0;
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
for(const name of names){
 const filename=Buffer.from(name),data=readFileSync(join(root,'dist/dashboard-ui',name));assert(data.length<0xffffffff);
 const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x21,12);
 header.writeUInt32LE(crc32(data),14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(filename.length,26);
 const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);header.copy(record,8,6,28);record.writeUInt32LE(offset,42);
 chunks.push(header,filename,data);central.push(record,filename);offset+=header.length+filename.length+data.length;
}
const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(names.length,8);end.writeUInt16LE(names.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
const bytes=Buffer.concat([...chunks,directory,end]),artifact=join(output,'awh-ui.zip');writeFileSync(artifact,bytes);
console.log(JSON.stringify({artifact,sha256:createHash('sha256').update(bytes).digest('hex'),files:names,published:false}));
