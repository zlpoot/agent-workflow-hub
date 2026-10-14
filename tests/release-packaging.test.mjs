import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { ids,specs,provenancePaths,viewerHelpers,sha256,checkArtifact,checkPortableClosure,auditFiles } from '../scripts/release-lib.mjs';
import { zipFiles,readZip,readTar,executableTar } from '../scripts/release-archive.mjs';
import { checkManifest,checkSums,validateRelease } from '../scripts/release-validate.mjs';

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
  if(component==='awh-viewer')for(const path of ['index.html','app.js','app.css','validators.cjs'])files['dist/dashboard-ui/'+path]=Buffer.from(path);
  if(component==='awh-viewer')for(const helper of viewerHelpers)files['dist/dashboard/'+helper]=Buffer.from('# synthetic fixed helper\n');
  if(component==='awh-viewer'||target==='static')for(const name of ['index.html','app.js','app.css'])files[(target==='static'?'v2/':'dist/dashboard-v2/')+name]=Buffer.from('v2/'+name);
  files[target==='static'?'dashboard-v1.openapi.json':'contracts/dashboard-v1.openapi.json']=Buffer.from('contracts/dashboard-v1.openapi.json');
  const build={schema_version:'1.0',kind:'awh_build',component,target,source_commit:source,source_clean:true,version:spec.version,node_major_min:24,build_environment:{os:'win32',cpu:'x64',node:'v24.21.0',npm:'11.0.0',pnpm:'not-used',typescript:'5.9.3',esbuild:'0.28.2'},provenance,runtime_dependencies:{},files:{}};
  modify(files,build);build.files=Object.fromEntries(Object.entries(files).map(([path,bytes])=>[path,sha256(bytes)]));files['awh-build.json']=Buffer.from(JSON.stringify(build));
  const bytes=target==='static'?zipFiles(files):tar(files);
  return {bytes,record:{component,target,filename:`${component}-${spec.version}-${target}.${target==='static'?'zip':'tgz'}`,source_commit:source,size_bytes:bytes.length,sha256:sha256(bytes),build}};
}
function setup(modify=()=>{}) {
  const assets=ids.map(id=>asset(id,(files,build)=>modify(id,files,build))),files=new Map(assets.map(a=>[a.record.filename,a.bytes])),manifest={schema_version:'1.0',kind:'awh_release_manifest',source_commit:source,source_clean:true,build_environment:assets[0].record.build.build_environment,provenance,components:specs,artifacts:assets.map(a=>a.record),compatibility:{node:'>=24',node_tarballs:'OS-neutral JS; Git required by Client/Builder',windows:['PowerShell 5.1','PowerShell 7'],cp_database_schema:2,protocol:'1.0',dashboard_api:'1.0.0',handoff:'0.1',new_external_database_required:true,mac_execution:'NOTRUN'},package_verification:'NOTRUN',release_gate:'NOT_AUTHORIZED'};
  files.set('install-windows.md',Buffer.from('Windows'));files.set('release-manifest.json',Buffer.from(JSON.stringify(manifest)));
  return {manifest,files,read:name=>{assert(files.has(name));return files.get(name);}};
}
test('five assets require a single source, build and structured version mapping without publishing authority',()=>{const h=setup();assert(checkManifest(h.manifest,h.read,source).valid);});
test('Manifest rejects missing/duplicate assets, source/version/toolchain drift and invented acceptance',()=>{
  for(const mutate of [m=>m.artifacts.pop(),m=>m.artifacts[1]=m.artifacts[0],m=>m.source_commit='b'.repeat(40),m=>m.artifacts[0].build.build_environment.node='v25.0.0',m=>m.artifacts[0].build.version='9.0.0',m=>m.package_verification='PASS',m=>m.release_gate='PASS',m=>m.compatibility.mac_execution='PASS']) {
    const h=setup();mutate(h.manifest);assert.throws(()=>checkManifest(h.manifest,h.read,source));
  }
});

function releaseKit(t,modify) {
  const h=setup(modify),base=mkdtempSync(join(tmpdir(),'awh-v2-release-regression-'));
  t.after(()=>{const target=realpathSync(base);assert.equal(dirname(target),realpathSync(tmpdir()));assert(basename(target).startsWith('awh-v2-release-regression-'));rmSync(target,{recursive:true,force:true});});
  for(const [name,bytes] of h.files)writeFileSync(join(base,name),bytes);
  writeFileSync(join(base,'SHA256SUMS'),[...h.files].map(([name,bytes])=>sha256(bytes)+'  '+name).join('\n')+'\n');
  // Every altered archive, build file map and checksum is rebuilt consistently,
  // so failures must come from the V2 format requirement, not damaged archives.
  return ()=>validateRelease(base,source);
}
test('V2 release accepts complete identical UI and Viewer assets',t=>{assert(releaseKit(t)().valid);});
test('Viewer release requires both fixed Owner helpers even with recomputed archive hashes',()=>{
  for(const helper of viewerHelpers){
    const a=asset('awh-viewer',files=>delete files['dist/dashboard/'+helper]);
    assert.throws(()=>checkArtifact(a.bytes,a.record,source),/Missing Viewer Owner helper/);
  }
  const a=asset('awh-viewer',files=>files['dist/dashboard/arbitrary.ps1']=Buffer.from('# synthetic extra helper'));
  assert.throws(()=>checkArtifact(a.bytes,a.record,source),/Undeclared platform helper/);
});
test('V2 release rejects both sides missing all V2 assets even with valid hashes',t=>{
  const validate=releaseKit(t,(component,files)=>{if(component==='awh-viewer'||component==='awh-dashboard-ui')for(const name of ['index.html','app.js','app.css'])delete files[(component==='awh-viewer'?'dist/dashboard-v2/':'v2/')+name];});
  assert.throws(validate,/Missing V2 (UI|Viewer) bytes/);
});
test('V2 release requires every asset on each side and rejects differing bytes',t=>{
  for(const component of ['awh-viewer','awh-dashboard-ui'])for(const name of ['index.html','app.js','app.css']){
    const validate=releaseKit(t,(id,files)=>{if(id===component)delete files[(id==='awh-viewer'?'dist/dashboard-v2/':'v2/')+name];});
    assert.throws(validate,/Missing V2 (UI|Viewer) bytes/,component+' '+name);
  }
  const differing=releaseKit(t,(component,files)=>{if(component==='awh-viewer')files['dist/dashboard-v2/app.js']=Buffer.from('different V2 bytes');});
  assert.throws(differing,/Viewer\/V2 UI built bytes differ/);
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
  for(const text of ['-----BEGIN PRIVATE KEY-----','-----BEGIN CERTIFICATE-----\n'+'A'.repeat(64)+'\n-----END CERTIFICATE-----','ghp_'+'a'.repeat(36),'awh_cp_'+'a'.repeat(43)])assert.throws(()=>auditFiles(new Map([['dist/hidden.json',{body:Buffer.from(text)}]])));
  auditFiles(new Map([['dist/validation.js',{body:Buffer.from('/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\\r\\n]+-----END CERTIFICATE-----/') }]]));
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
