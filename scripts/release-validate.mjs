import assert from 'node:assert/strict';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkArtifact, closed, ids, specs, sha256 } from './release-lib.mjs';

export function checkManifest(manifest, read, expectedHead) {
  closed(manifest,['schema_version','kind','source_commit','source_clean','build_environment','provenance','components','artifacts','compatibility','package_verification','release_gate']);
  assert.equal(manifest.schema_version,'1.0'); assert.equal(manifest.kind,'awh_release_manifest');
  assert(/^[a-f0-9]{40}$/.test(expectedHead)); assert.equal(manifest.source_commit,expectedHead);
  assert.equal(manifest.source_clean,true); assert.equal(manifest.release_gate,'NOT_AUTHORIZED');
  assert.equal(manifest.package_verification,'NOTRUN','Platform evidence is a separate exact-byte record');
  assert.deepEqual(manifest.components,specs); assert.deepEqual(manifest.artifacts.map(a=>a.component).sort(),[...ids].sort());
  assert.equal(new Set(manifest.artifacts.map(a=>a.filename)).size,5);
  assert.deepEqual(manifest.compatibility,{node:'>=24',node_tarballs:'OS-neutral JS; Git required by Client/Builder',windows:['PowerShell 5.1','PowerShell 7'],cp_database_schema:2,protocol:'1.0',dashboard_api:'1.0.0',handoff:'0.1',new_external_database_required:true,mac_execution:'NOTRUN'});
  for(const artifact of manifest.artifacts) {
    assert.equal(artifact.filename,`${artifact.component}-${specs[artifact.component]?.version}-${artifact.target}.${artifact.target==='static'?'zip':'tgz'}`,'Validate path before external read');
    const build=checkArtifact(read(artifact.filename),artifact,expectedHead);
    assert.deepEqual(build.build_environment,manifest.build_environment); assert.deepEqual(build.provenance,manifest.provenance);
  }
  return {valid:true,source_commit:expectedHead,assets:5,authority_verified:false,release_authorized:false};
}
export function checkSums(text,manifest,read) {
  const expected=[...manifest.artifacts.map(a=>a.filename),'release-manifest.json','install-windows.md'].sort(), seen=[];
  assert(text.endsWith('\n'));
  for(const line of text.trimEnd().split('\n')) {
    const match=/^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/.exec(line); assert(match,'Invalid checksum line/path');
    const [,hash,name]=match; assert(expected.includes(name)&&!seen.includes(name)); seen.push(name); assert.equal(sha256(read(name)),hash,'SHA256 mismatch: '+name);
  }
  assert.deepEqual(seen.sort(),expected); return true;
}
export function validateRelease(directory,expectedHead) {
  const base=realpathSync(directory), read=name=>readFileSync(join(base,name));
  const manifest=JSON.parse(read('release-manifest.json')),result=checkManifest(manifest,read,expectedHead);
  checkSums(read('SHA256SUMS').toString('utf8'),manifest,read);
  assert.deepEqual(readdirSync(base).sort(),[...manifest.artifacts.map(a=>a.filename),'release-manifest.json','SHA256SUMS','install-windows.md'].sort(),'Unexpected release directory contents');
  const viewer=manifest.artifacts.find(a=>a.component==='awh-viewer'),ui=manifest.artifacts.find(a=>a.component==='awh-dashboard-ui');
  for(const name of ['index.html','app.js','app.css','validators.cjs'])assert.equal(viewer.build.files['dist/dashboard-ui/'+name],ui.build.files[name],'Viewer/UI built bytes differ');
  return {...result,checksums:'PASS',archive_audit:'PASS',runtime_closure:'PASS'};
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const args=process.argv.slice(2);assert(args.length===3&&args[1]==='--expected-head','release-validate <kit-dir> --expected-head <sha>');
  console.log(JSON.stringify(validateRelease(args[0],args[2])));
}
