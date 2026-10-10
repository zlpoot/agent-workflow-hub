import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { ids,specs,components,provenancePaths,sha256,checkArtifact,readArtifact,checkCandidate,checkPortableClosure } from '../scripts/release-lib.mjs';
import { zipFiles,readZip,readTar,executableTar } from '../scripts/release-archive.mjs';
import { checkManifest,checkSums,checkSmoke,checkPlatformEvidence,smokeChecks } from '../scripts/release-validate.mjs';

// Tiny synthetic archives exercise verifier failure modes; never evidence of platform execution.
const source='a'.repeat(40),provenance=Object.fromEntries(provenancePaths.map(p=>[p,sha256(Buffer.from(p))]));
function tar(files) {
  const chunks=[];for(const [name,b] of Object.entries(files)){const h=Buffer.alloc(512);h.write('package/'+name);h.write('0000755\0',100);h.write('0000000\0',108);h.write('0000000\0',116);h.write(b.length.toString(8).padStart(11,'0')+'\0',124);h.fill(32,148,156);h.write('0',156);h.write('ustar\0',257);const sum=h.reduce((n,b)=>n+b,0);h.write(sum.toString(8).padStart(6,'0')+'\0 ',148);chunks.push(h,b,Buffer.alloc((512-b.length%512)%512));}return gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]));
}
function asset(component,target,modify=()=>{}) {
  const spec=specs[component],files={};
  if(target==='static'){for(const p of ['index.html','app.js','app.css','validators.cjs','build-inputs.json'])files[p]=Buffer.from(p);files['dashboard-v1.openapi.json']=Buffer.from('contracts/dashboard-v1.openapi.json');}
  else{files['package.json']=Buffer.from(JSON.stringify({name:spec.name,version:spec.version,private:true,type:'module',engines:{node:'>=24'},bin:spec.bin,dependencies:{}}));files['contracts/dashboard-v1.openapi.json']=Buffer.from('contracts/dashboard-v1.openapi.json');for(const p of Object.values(spec.bin))files[p]=Buffer.from('#!/usr/bin/env node\n');}
  const build={schema_version:'1.0',kind:'awh_build',component,target,source_commit:source,source_clean:true,version:spec.version,node_major_min:24,build_environment:{os:'win32',cpu:'x64',node:'v24.21.0',npm:'11.0.0',pnpm:'not-used',typescript:'5.9.3',esbuild:'0.28.2'},provenance,runtime_dependencies:{},files:{}};
  modify(files,build);build.files=Object.fromEntries(Object.entries(files).map(([p,b])=>[p,sha256(b)]));files['awh-build.json']=Buffer.from(JSON.stringify(build));const bytes=target==='static'?zipFiles(files):tar(files);
  return {bytes,record:{component,target,filename:`${component}-${spec.version}-${target}.${target==='static'?'zip':'tgz'}`,source_commit:source,size_bytes:bytes.length,sha256:sha256(bytes),build}};
}
function setup() {
  const assets=ids.map(id=>asset(id,id==='awh-dashboard-ui'?'static':'universal')),files=new Map(assets.map(a=>[a.record.filename,a.bytes]));
  const guides={windows:{filename:'install-windows.md',sha256:sha256(Buffer.from('Windows'))},macos:{filename:'install-macos.md',sha256:sha256(Buffer.from('Mac'))}};files.set('install-windows.md',Buffer.from('Windows'));files.set('install-macos.md',Buffer.from('Mac'));
  const manifest={schema_version:'1.0',kind:'awh_release_manifest',release:{id:'awh-'+source+'-rc.1',name:'AWH v0.1.0-rc.1',tag:'v0.1.0-rc.1',channel:'rc',state:'candidate_frozen',source_commit:source,source_clean:true,human_release_gate:'NOT_AUTHORIZED'},components,artifacts:assets.map(a=>a.record),compatibility:{protocol:'1.0',cp_database_schema:2,dashboard_api:'1.0.0',dashboard_contract_sha256:provenance['contracts/dashboard-v1.openapi.json'],handoff:'0.1',fixed_profile_policy_sha256:provenance['src/profiles.ts']},verification:['win32-x64','darwin-arm64'].map(target=>({layer:'package',target,status:'NOTRUN',evidence:null})),unsupported_targets:[{target:'darwin-x64',status:'NOT_VERIFIED'},{target:'other',status:'NOT_VERIFIED'}],acceptance:{runtime_write:'NOT_ACCEPTED',full_delivery:'NOT_ACCEPTED'},historical_dispositions:{issue30:'PHASE_C_ACCEPTED_WITH_EXCEPTION',issue35:'WINDOWS_FIRST_USABLE_OBSERVE_ONLY',onboarding_api_1_0_0:'OFFLINE_FIXTURE_ONLY'},guides};return {manifest,files,read:n=>{assert(files.has(n));return files.get(n);}};
}
test('five universal components share targets legally; NOTRUN never grants package/publishing authority',()=>{const h=setup();assert.deepEqual(checkManifest(h.manifest,h.read,source),{valid:true,publishable:false,package_acceptance:false,authority_verified:false});});
test('manifest fails closed on missing/duplicate pairs, unknown components/fields, source and hash drift',()=>{
  const mutations=[m=>m.artifacts.pop(),m=>m.artifacts[1]=m.artifacts[0],m=>m.artifacts[0].component='unknown',m=>m.components.push(m.components[0]),m=>m.artifacts[0].filename=m.artifacts[1].filename,m=>m.release.source_commit='b'.repeat(40),m=>m.artifacts[0].sha256='0'.repeat(64),m=>m.deployments=[],m=>m.release.human_release_gate='PASS',m=>m.verification[0].status='PASS',m=>m.kind='awh_release_plan',m=>m.artifacts[0].build.build_environment.os='darwin'];
  for(const mutate of mutations){const h=setup(),m=structuredClone(h.manifest);mutate(m);assert.throws(()=>checkManifest(m,h.read,source));}
});
test('a recomputed tar hash cannot conceal a missing relative import or dependency',()=>{
  for(const content of ["#!/usr/bin/env node\nimport './missing.js';\n","#!/usr/bin/env node\nimport 'unknown-package';\n"]){const a=asset('awh-builder','universal',(files,build)=>{files['dist/builder-cli.js']=Buffer.from(content);build.files['dist/builder-cli.js']=sha256(files['dist/builder-cli.js']);});assert.throws(()=>checkArtifact(a.bytes,a.record,source));}
});
test('actual build host and closure file inventory remain checked independently of portable target',()=>{
  const a=asset('awh-viewer','universal',(_f,b)=>b.build_environment.os='linux');assert.throws(()=>checkArtifact(a.bytes,a.record,source));
  const b=asset('awh-builder','universal',(f)=>f['credentials/key.pem']=Buffer.from('synthetic'));assert.throws(()=>checkArtifact(b.bytes,b.record,source));
  const c=asset('awh-viewer','universal',(_f,b)=>{b.build_environment.os='darwin';b.build_environment.cpu='arm64';});assert(checkArtifact(c.bytes,c.record,source));
});
test('universal candidate cannot omit a component or claim smoke PASS in immutable index',()=>{const h=setup(),c={schema_version:'1.0',kind:'awh_release_candidate',source_commit:source,source_clean:true,target:'universal',artifacts:[...h.manifest.artifacts],package_verification:'NOTRUN',runtime_write:'NOTRUN',full_delivery:'NOTRUN',release_gate:'NOT_AUTHORIZED'};assert(checkCandidate(c,h.read));c.package_verification='PASS';assert.throws(()=>checkCandidate(c,h.read));c.package_verification='NOTRUN';c.artifacts.pop();assert.throws(()=>checkCandidate(c,h.read));});
test('checksums require all assets/guides/manifest, reject self-hash, duplicates and modified bytes',()=>{const h=setup();h.files.set('release-manifest.json',Buffer.from(JSON.stringify(h.manifest)));const sums=[...h.files].map(([p,b])=>sha256(b)+'  '+p).join('\n')+'\n';assert(checkSums(sums,h.manifest,h.read));assert.throws(()=>checkSums(sums+sha256(Buffer.from(''))+'  SHA256SUMS\n',h.manifest,h.read));assert.throws(()=>checkSums(sums+sums.split('\n')[0]+'\n',h.manifest,h.read));h.files.set(h.manifest.artifacts[0].filename,Buffer.from('modified'));assert.throws(()=>checkSums(sums,h.manifest,h.read));});
test('archive validation rejects corrupt bytes and unsafe names',()=>{const zip=zipFiles({a:Buffer.from('hello')});assert.equal(readZip(zip).get('a').toString(),'hello');const bad=Buffer.from(zip);bad[31]^=1;assert.throws(()=>readZip(bad));assert.throws(()=>zipFiles({'../escape':Buffer.from('x')}));const tgz=asset('awh-builder','universal').bytes;assert(readTar(tgz).has('awh-build.json'));assert.throws(()=>readTar(Buffer.from('bad')));});
test('npm Windows archive modes normalize declared bins without changing runtime bytes',()=>{const original=asset('awh-builder','universal').bytes,paths=Object.values(specs['awh-builder'].bin),normalized=executableTar(original,paths),before=readTar(original),after=readTar(normalized);for(const [p,b]of before)assert(b.body.equals(after.get(p).body));for(const p of paths)assert.equal(after.get(p).mode,0o755);assert.throws(()=>executableTar(original,['dist/missing.js']));});
test('untrusted artifact filename is rejected before any external read',()=>{const a=asset('awh-builder','universal');a.record.filename='../../credentials/key.pem';let reads=0;assert.throws(()=>readArtifact(a.record,source,()=>{reads++;return a.bytes;}));assert.equal(reads,0);});

test('native bytes, OS constraints and hidden dependency imports fail even with recomputed archive/file hashes',()=>{
  for(const [name,bytes] of [['addon.node',Buffer.from('fake')],['hidden.dat',Buffer.from([0x7f,0x45,0x4c,0x46])],['hidden.bin',Buffer.from('MZ executable')],['tool.dylib',Buffer.from('fake')]]) {
    const a=asset('awh-builder','universal',f=>f['dist/'+name]=bytes);assert.throws(()=>checkArtifact(a.bytes,a.record,source));
  }
  for(const fields of [{os:['win32']},{cpu:['x64']},{os:[]},{cpu:[]}]) {
    const a=asset('awh-builder','universal',f=>{const p=JSON.parse(f['package.json']);Object.assign(p,fields);f['package.json']=Buffer.from(JSON.stringify(p));});assert.throws(()=>checkArtifact(a.bytes,a.record,source));
  }
  for(const content of ["require('./missing')",'require(variable)',"import('unknown')",'import(variable)']) {
    const archive=new Map([['node_modules/example/package.json',{body:Buffer.from(JSON.stringify({name:'example',version:'1.0.0'}))}],['node_modules/example/index.js',{body:Buffer.from(content)}]]);assert.throws(()=>checkPortableClosure(archive,{example:'1.0.0'}));
  }
  for(const fields of [{os:['win32']},{scripts:{install:'node configure.js'}},{optionalDependencies:{addon:'1.0.0'}}]) {
    const archive=new Map([['node_modules/example/package.json',{body:Buffer.from(JSON.stringify({name:'example',version:'1.0.0',...fields}))}]]);assert.throws(()=>checkPortableClosure(archive,{example:'1.0.0'}));
  }
});

test('dependency import closure accepts retained modules and rejects missing bare subpaths/inventory',()=>{
  const archive=new Map([['node_modules/example/package.json',{body:Buffer.from(JSON.stringify({name:'example',version:'1.0.0'}))}],['node_modules/example/index.js',{body:Buffer.from("require('./lib');require('node:path');require('example/lib')")}],['node_modules/example/lib.js',{body:Buffer.from('module.exports=1;')}]]);
  checkPortableClosure(archive,{example:'1.0.0'});archive.delete('node_modules/example/lib.js');assert.throws(()=>checkPortableClosure(archive,{example:'1.0.0'}));
  archive.set('node_modules/example/index.js',{body:Buffer.from("require('example/missing')")});assert.throws(()=>checkPortableClosure(archive,{example:'1.0.0'}));assert.throws(()=>checkPortableClosure(archive,{}));
});

function smoke(h,target='win32-x64') {
  const [os,cpu]=target.split('-');return {schema_version:'1.0',kind:'awh_package_smoke',source_commit:source,target,status:'PASS',artifacts:h.manifest.artifacts.map(a=>({component:a.component,sha256:a.sha256})),checks:Object.fromEntries(smokeChecks.map(k=>[k,'PASS'])),environment:{os,cpu,node:'v24.21.0',npm:'11.0.0',browser:'140.0.0.0'},failure:null,model_calls:0,production_touched:false};
}
test('Windows and Mac evidence binds identical bytes but independent actual platform execution',()=>{
  const h=setup(),before=JSON.stringify(h.manifest),external=new Map();
  const read=n=>external.get(n)??null;
  assert.deepEqual(checkPlatformEvidence(h.manifest,read).map(v=>v.status),['NOTRUN','NOTRUN']);
  external.set('package-smoke-win32-x64.json',Buffer.from(JSON.stringify(smoke(h))));
  assert.deepEqual(checkPlatformEvidence(h.manifest,read).map(v=>v.status),['PASS','NOTRUN']);
  const mac=smoke(h,'darwin-arm64');mac.status='BLOCKED';mac.failure='PACKAGE_SMOKE_FAILED';mac.environment.browser=null;delete mac.checks.viewer_ui;
  external.set('package-smoke-darwin-arm64.json',Buffer.from(JSON.stringify(mac)));assert.deepEqual(checkPlatformEvidence(h.manifest,read).map(v=>v.status),['PASS','BLOCKED']);
  external.set('package-smoke-darwin-arm64.json',Buffer.from(JSON.stringify(smoke(h,'darwin-arm64'))));assert(checkPlatformEvidence(h.manifest,read).every(v=>v.status==='PASS'));
  assert.equal(JSON.stringify(h.manifest),before);assert.equal(checkManifest(h.manifest,h.read,source).publishable,false);
});
test('platform evidence rejects substituted/rebuilt packages, host/source drift, missing checks and forged PASS',()=>{
  const h=setup(),mutations=[e=>e.source_commit='b'.repeat(40),e=>e.environment.os='darwin',e=>e.environment.cpu='arm64',e=>e.artifacts[0].sha256='f'.repeat(64),e=>e.artifacts.pop(),e=>e.artifacts[1]=e.artifacts[0],e=>delete e.checks.reinstall,e=>e.checks.viewer_ui='NOTRUN',e=>e.failure='PACKAGE_SMOKE_FAILED',e=>e.environment.browser=null,e=>e.production_touched=true,e=>e.authority_verified=true];
  for(const change of mutations){const e=smoke(h);change(e);assert.throws(()=>checkSmoke(e,h.manifest.artifacts,source,'win32-x64'));}
  assert.throws(()=>checkSmoke(smoke(h),h.manifest.artifacts,source,'darwin-arm64'));
});
