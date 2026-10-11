import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { ids,specs,provenancePaths,sha256,checkArtifact,checkPortableClosure,auditFiles } from '../scripts/release-lib.mjs';
import { zipFiles,readZip,readTar,executableTar } from '../scripts/release-archive.mjs';
import { checkManifest,checkSums } from '../scripts/release-validate.mjs';

// Synthetic archive bytes test rejection modes; never platform acceptance evidence.
const source='a'.repeat(40),provenance=Object.fromEntries(provenancePaths.map(p=>[p,sha256(Buffer.from(p))]));
function tar(files) {
  const chunks=[];
  for(const [name,b] of Object.entries(files)) {
    const h=Buffer.alloc(512);h.write('package/'+name);h.write('0000755\0',100);h.write('0000000\0',108);h.write('0000000\0',116);h.write(b.length.toString(8).padStart(11,'0')+'\0',124);h.fill(32,148,156);h.write('0',156);h.write('ustar\0',257);h.write(h.reduce((n,b)=>n+b,0).toString(8).padStart(6,'0')+'\0 ',148);
    chunks.push(h,b,Buffer.alloc((512-b.length%512)%512));
  }return gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]));
}
function asset(component,modify=()=>{}) {
  const spec=specs[component],target=spec.name?'universal':'static',files={};
  if(target==='static')for(const path of ['index.html','app.js','app.css','validators.cjs'])files[path]=Buffer.from(path);
  else {
    files['package.json']=Buffer.from(JSON.stringify({name:spec.name,version:spec.version,private:true,type:'module',engines:{node:'>=24'},bin:spec.bin,dependencies:{}}));
    for(const path of Object.values(spec.bin))files[path]=Buffer.from('#!/usr/bin/env node\n');
  }
  files[target==='static'?'dashboard-v1.openapi.json':'contracts/dashboard-v1.openapi.json']=Buffer.from('contracts/dashboard-v1.openapi.json');
  const build={schema_version:'1.0',kind:'awh_build',component,target,source_commit:source,source_clean:true,version:spec.version,node_major_min:24,build_environment:{os:'win32',cpu:'x64',node:'v24.21.0',npm:'11.0.0',pnpm:'not-used',typescript:'5.9.3',esbuild:'0.28.2'},provenance,runtime_dependencies:{},files:{}};
  modify(files,build);build.files=Object.fromEntries(Object.entries(files).map(([path,bytes])=>[path,sha256(bytes)]));files['awh-build.json']=Buffer.from(JSON.stringify(build));
  const bytes=target==='static'?zipFiles(files):tar(files);
  return {bytes,record:{component,target,filename:`${component}-${spec.version}-${target}.${target==='static'?'zip':'tgz'}`,source_commit:source,size_bytes:bytes.length,sha256:sha256(bytes),build}};
}
function setup() {
  const assets=ids.map(id=>asset(id)),files=new Map(assets.map(a=>[a.record.filename,a.bytes])),manifest={schema_version:'1.0',kind:'awh_release_manifest',source_commit:source,source_clean:true,build_environment:assets[0].record.build.build_environment,provenance,components:specs,artifacts:assets.map(a=>a.record),compatibility:{node:'>=24',node_tarballs:'OS-neutral JS; Git required by Client/Builder',windows:['PowerShell 5.1','PowerShell 7'],cp_database_schema:2,protocol:'1.0',dashboard_api:'1.0.0',handoff:'0.1',new_external_database_required:true,mac_execution:'NOTRUN'},package_verification:'NOTRUN',release_gate:'NOT_AUTHORIZED'};
  files.set('install-windows.md',Buffer.from('Windows'));files.set('release-manifest.json',Buffer.from(JSON.stringify(manifest)));
  return {manifest,files,read:name=>{assert(files.has(name));return files.get(name);}};
}
test('five assets require a single source, build and structured version mapping without publishing authority',()=>{const h=setup();assert(checkManifest(h.manifest,h.read,source).valid);});
test('Manifest rejects missing/duplicate assets, source/version/toolchain drift and invented acceptance',()=>{
  for(const mutate of [m=>m.artifacts.pop(),m=>m.artifacts[1]=m.artifacts[0],m=>m.source_commit='b'.repeat(40),m=>m.artifacts[0].build.build_environment.node='v25.0.0',m=>m.artifacts[0].build.version='9.0.0',m=>m.package_verification='PASS',m=>m.release_gate='PASS',m=>m.compatibility.mac_execution='PASS']) {
    const h=setup();mutate(h.manifest);assert.throws(()=>checkManifest(h.manifest,h.read,source));
  }
});
test('unsafe artifact paths are rejected before external reads',()=>{const h=setup();h.manifest.artifacts[0].filename='../secret';let reads=0;assert.throws(()=>checkManifest(h.manifest,()=>{reads++;},source));assert.equal(reads,0);});
test('SHA256SUMS rejects substituted bytes, missing/duplicate records, unsafe names and self hashes',()=>{
  const h=setup(),sums=[...h.files].map(([path,bytes])=>sha256(bytes)+'  '+path).join('\n')+'\n';assert(checkSums(sums,h.manifest,h.read));
  for(const changed of [sums.split('\n').slice(1).join('\n'),sums+sums.split('\n')[0]+'\n',sums+sha256(Buffer.from(''))+'  ../secret\n',sums+sha256(Buffer.from(''))+'  SHA256SUMS\n'])assert.throws(()=>checkSums(changed,h.manifest,h.read));
  h.files.set(h.manifest.artifacts[0].filename,Buffer.from('changed'));assert.throws(()=>checkSums(sums,h.manifest,h.read));
});
test('recomputed archive hashes cannot conceal missing imports or undeclared runtime dependencies',()=>{
  for(const text of ["#!/usr/bin/env node\nimport './missing.js';","#!/usr/bin/env node\nimport 'unknown';"]){const a=asset('awh-builder',f=>f['dist/builder-cli.js']=Buffer.from(text));assert.throws(()=>checkArtifact(a.bytes,a.record,source));}
});
test('actual archive audit rejects credentials, business SQLite, fixtures, retired entrypoints and native files',()=>{
  for(const path of ['fixture/x.json','tests/x.js','examples/x.json','credentials/key.pem','dist/state.sqlite-wal','dist/session-host.js','dist/viewer-cli.js','dist/addon.node']) {
    const a=asset('awh-builder',f=>f[path]=Buffer.from('synthetic'));assert.throws(()=>checkArtifact(a.bytes,a.record,source),path);
  }
  for(const text of ['-----BEGIN PRIVATE KEY-----','ghp_'+'a'.repeat(36),'awh_cp_'+'a'.repeat(43)])assert.throws(()=>auditFiles(new Map([['dist/hidden.json',{body:Buffer.from(text)}]])));
});
test('dependency closure rejects hidden imports, native metadata and lifecycle scripts',()=>{
  for(const text of ["require('./missing')",'require(variable)',"import('unknown')"]) {
    const archive=new Map([['node_modules/example/package.json',{body:Buffer.from('{"name":"example","version":"1.0.0"}')}],['node_modules/example/index.js',{body:Buffer.from(text)}]]);assert.throws(()=>checkPortableClosure(archive,{example:'1.0.0'}));
  }
  for(const fields of [{os:['win32']},{scripts:{install:'node setup.js'}},{optionalDependencies:{native:'1.0.0'}}])assert.throws(()=>checkPortableClosure(new Map([['node_modules/example/package.json',{body:Buffer.from(JSON.stringify(fields))}]]),{example:'1.0.0'}));
});
test('ZIP corruption/traversal and npm bin mode normalization retain exact runtime bytes',()=>{
  const zip=zipFiles({a:Buffer.from('hello')}),bad=Buffer.from(zip);bad[31]^=1;assert.equal(readZip(zip).get('a').toString(),'hello');assert.throws(()=>readZip(bad));assert.throws(()=>zipFiles({'../escape':Buffer.from('x')}));
  const a=asset('awh-builder'),bins=Object.values(specs['awh-builder'].bin),normalized=readTar(executableTar(a.bytes,bins)),original=readTar(a.bytes);
  for(const [path,entry] of original)assert.deepEqual(entry.body,normalized.get(path).body);
  for(const bin of bins)assert.equal(normalized.get(bin).mode,0o755);assert.throws(()=>executableTar(a.bytes,['dist/missing.js']));
});
