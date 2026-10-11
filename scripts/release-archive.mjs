import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';

export function safeName(name) {
  assert(typeof name === 'string' && name && !name.includes('\\') && !name.startsWith('/') && !name.includes(':') &&
    name.split('/').every(p => p && p !== '.' && p !== '..') && !/[\x00-\x1f]/.test(name), 'Unsafe archive path');
  return name;
}
export function readTar(bytes) {
  const data = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 }), files = new Map(); let offset = 0, pax = {};
  const text = b => b.toString('utf8').replace(/\0.*$/s, '');
  const octal = b => { const value = text(b).trim(); assert(/^[0-7]*$/.test(value)); return parseInt(value || '0', 8); };
  while (offset + 512 <= data.length) {
    const h = data.subarray(offset, offset + 512); if (h.every(b => !b)) break;
    const checksum = octal(h.subarray(148,156)); assert.equal(h.reduce((n,b,i) => n + (i >= 148 && i < 156 ? 32 : b), 0), checksum, 'Tar checksum mismatch');
    const size = octal(h.subarray(124,136)), type = text(h.subarray(156,157)), prefix = text(h.subarray(345,500));
    let name = (prefix ? prefix + '/' : '') + text(h.subarray(0,100));
    offset += 512; assert(offset + size <= data.length, 'Truncated tar'); const body = data.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pax = {}; let p = 0;
      while (p < body.length) { const end = body.indexOf(32,p), length = Number(body.subarray(p,end).toString()); assert(end > p && Number.isInteger(length) && length > 0 && p + length <= body.length); const line = body.subarray(end+1,p+length-1).toString(); const eq = line.indexOf('='); assert(eq > 0); pax[line.slice(0,eq)] = line.slice(eq+1); p += length; }
      assert(Object.keys(pax).every(k => ['path','mtime','atime','ctime'].includes(k)), 'Unsupported tar extension'); continue;
    }
    name = pax.path ?? name; pax = {};
    if (type === '5') { safeName(name.replace(/\/$/,'')); continue; }
    assert(type === '' || type === '0', 'Links/special tar entries forbidden'); safeName(name);
    assert(name.startsWith('package/') && !files.has(name.slice(8)), 'Duplicate or out-of-package tar entry');
    files.set(name.slice(8), { body: Buffer.from(body), mode: octal(h.subarray(100,108)) });
  }
  assert(files.size && Object.keys(pax).length === 0, 'Empty/incomplete tar'); return files;
}
export function executableTar(bytes, bins) {
  const files=readTar(bytes);for(const bin of bins)assert(files.has(bin),'Missing bin');
  const data=gunzipSync(bytes,{maxOutputLength:128*1024*1024});let offset=0,changed=0;
  while(offset+512<=data.length){const h=data.subarray(offset,offset+512);if(h.every(b=>!b))break;
    const text=b=>b.toString('utf8').replace(/\0.*$/s,''),prefix=text(h.subarray(345,500)),name=(prefix?prefix+'/':'')+text(h.subarray(0,100));
    const size=parseInt(text(h.subarray(124,136)).trim()||'0',8);
    if(bins.includes(name.replace(/^package\//,''))){assert.equal(text(h.subarray(156,157)),'0');h.write('0000755\0',100);h.fill(32,148,156);h.write(h.reduce((n,b)=>n+b,0).toString(8).padStart(6,'0')+'\0 ',148);changed++;}
    offset+=512+Math.ceil(size/512)*512;
  }
  assert.equal(changed,bins.length,'Ambiguous bin headers');return gzipSync(data);
}
function crc32(data) { let c = 0xffffffff; for (const b of data) { c ^= b; for(let j=0;j<8;j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
// Deliberately small stored ZIP subset; no executable external archive tools or symlinks.
export function zipFiles(files) {
  const local = [], central = []; let offset = 0;
  for (const [path,body] of Object.entries(files).sort(([a],[b]) => a.localeCompare(b))) {
    safeName(path); const name = Buffer.from(path), crc = crc32(body), h = Buffer.alloc(30), d = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20,4); h.writeUInt16LE(0x800,6); h.writeUInt16LE(0x21,12); h.writeUInt32LE(crc,14); h.writeUInt32LE(body.length,18); h.writeUInt32LE(body.length,22); h.writeUInt16LE(name.length,26);
    d.writeUInt32LE(0x02014b50); d.writeUInt16LE(20,4); d.writeUInt16LE(20,6); d.writeUInt16LE(0x800,8); d.writeUInt16LE(0x21,14); d.writeUInt32LE(crc,16); d.writeUInt32LE(body.length,20); d.writeUInt32LE(body.length,24); d.writeUInt16LE(name.length,28); d.writeUInt32LE(offset,42);
    local.push(h,name,body); central.push(d,name); offset += h.length + name.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22), count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count,8); end.writeUInt16LE(count,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
export function readZip(bytes) {
  const files = new Map(); let offset = 0;
  const end = bytes.subarray(-22); assert.equal(end.readUInt32LE(0),0x06054b50); assert.equal(end.readUInt16LE(20),0); assert.equal(end.readUInt32LE(12)+end.readUInt32LE(16),bytes.length-22);
  while (offset < end.readUInt32LE(16)) {
    assert.equal(bytes.readUInt32LE(offset),0x04034b50); assert.equal(bytes.readUInt16LE(offset+6),0x800); assert.equal(bytes.readUInt16LE(offset+8),0); assert.equal(bytes.readUInt16LE(offset+28),0);
    const size = bytes.readUInt32LE(offset+18), length = bytes.readUInt16LE(offset+26); assert.equal(bytes.readUInt32LE(offset+22),size);
    const name = bytes.subarray(offset+30,offset+30+length).toString('utf8'); safeName(name); assert(!files.has(name));
    const body = bytes.subarray(offset+30+length,offset+30+length+size); assert.equal(body.length,size); assert.equal(crc32(body),bytes.readUInt32LE(offset+14)); files.set(name,Buffer.from(body)); offset += 30 + length + size;
  }
  assert.equal(offset,end.readUInt32LE(16)); assert.equal(files.size,end.readUInt16LE(10));
  let p = offset;
  for (const [name,body] of files) {
    assert.equal(bytes.readUInt32LE(p),0x02014b50); const length = bytes.readUInt16LE(p+28); assert.equal(bytes.subarray(p+46,p+46+length).toString(),name); assert.equal(bytes.readUInt32LE(p+16),crc32(body)); assert.equal(bytes.readUInt32LE(p+20),body.length); assert.equal(bytes.readUInt16LE(p+30),0); assert.equal(bytes.readUInt16LE(p+32),0); p += 46+length;
  }
  assert.equal(p,bytes.length-22); return files;
}
