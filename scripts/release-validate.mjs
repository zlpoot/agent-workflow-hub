import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { checkCandidate, readArtifact, closed, ids, components, targets, sha256 } from './release-lib.mjs';
import { pathToFileURL } from 'node:url';

export function checkManifest(manifest, read, expectedSource) {
  closed(manifest,['schema_version','kind','release','components','artifacts','compatibility','verification','unsupported_targets','acceptance','historical_dispositions','guides']);
  assert.equal(manifest.schema_version,'1.0'); assert.equal(manifest.kind,'awh_release_manifest');
  closed(manifest.release,['id','name','tag','channel','state','source_commit','source_clean','human_release_gate']);
  assert.equal(manifest.release.source_commit,expectedSource);assert.equal(manifest.release.source_clean,true);assert.equal(manifest.release.id,'awh-'+expectedSource+'-rc.1');assert.equal(manifest.release.name,'AWH v0.1.0-rc.1');assert.equal(manifest.release.tag,'v0.1.0-rc.1');assert.equal(manifest.release.channel,'rc');assert.equal(manifest.release.state,'candidate_frozen');assert.equal(manifest.release.human_release_gate,'NOT_AUTHORIZED');
  assert.deepEqual(manifest.components,components); assert.equal(manifest.artifacts.length,5);
  const combos=ids.map(id=>id+'\0'+(id==='awh-dashboard-ui'?'static':'universal'));
  assert.deepEqual(manifest.artifacts.map(a=>a.component+'\0'+a.target).sort(),combos.sort());assert.equal(new Set(manifest.artifacts.map(a=>a.filename)).size,5);
  for(const a of manifest.artifacts)readArtifact(a,expectedSource,read);
  const provenance=manifest.artifacts[0].build.provenance;for(const a of manifest.artifacts)assert.deepEqual(a.build.provenance,provenance);
  closed(manifest.guides,['windows','macos']);for(const g of Object.values(manifest.guides)){closed(g,['filename','sha256']);assert(['install-windows.md','install-macos.md'].includes(g.filename));assert.equal(sha256(read(g.filename)),g.sha256);}
  assert.deepEqual(manifest.compatibility,{protocol:'1.0',cp_database_schema:2,dashboard_api:'1.0.0',dashboard_contract_sha256:provenance['contracts/dashboard-v1.openapi.json'],handoff:'0.1',fixed_profile_policy_sha256:provenance['src/profiles.ts']});
  assert.deepEqual(manifest.unsupported_targets,[{target:'darwin-x64',status:'NOT_VERIFIED'},{target:'other',status:'NOT_VERIFIED'}]);
  assert.deepEqual(manifest.acceptance,{runtime_write:'NOT_ACCEPTED',full_delivery:'NOT_ACCEPTED'});
  assert.deepEqual(manifest.historical_dispositions,{issue30:'PHASE_C_ACCEPTED_WITH_EXCEPTION',issue35:'WINDOWS_FIRST_USABLE_OBSERVE_ONLY',onboarding_api_1_0_0:'OFFLINE_FIXTURE_ONLY'});
  assert.equal(manifest.verification.length,2);
  for(const [index,target] of targets.entries()) {
    const v=manifest.verification[index];closed(v,['layer','target','status','evidence']);assert.equal(v.layer,'package');assert.equal(v.target,target);
    assert.equal(v.status,'NOTRUN','Frozen manifest records build-time status; later evidence is external');assert.equal(v.evidence,null);
  }
  return {valid:true,publishable:false,package_acceptance:false,authority_verified:false};
}
export const smokeChecks=['builder_offline','client_doctor','cp_scratch','empty_cache_install','reinstall','viewer_ui','shims'];
export function checkSmoke(e, artifacts, source, target) {
  closed(e,['schema_version','kind','source_commit','target','status','artifacts','checks','environment','failure','model_calls','production_touched']);
  assert(targets.includes(target));assert.equal(e.kind,'awh_package_smoke');assert.equal(e.schema_version,'1.0');assert.equal(e.source_commit,source);assert.equal(e.target,target);assert(['PASS','BLOCKED'].includes(e.status));assert.equal(e.model_calls,0);assert.equal(e.production_touched,false);
  const required=artifacts.map(a=>({component:a.component,sha256:a.sha256}));assert.deepEqual([...e.artifacts].sort((a,b)=>a.component.localeCompare(b.component)),required.sort((a,b)=>a.component.localeCompare(b.component)));
  closed(e.environment,['os','cpu','node','npm','browser']);assert.equal(e.environment.os+'-'+e.environment.cpu,target);assert(/^v(?:2[4-9]|[3-9]\d)\./.test(e.environment.node));assert(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(e.environment.npm));
  assert(Object.keys(e.checks).every(k=>smokeChecks.includes(k)));for(const check of Object.values(e.checks))assert.equal(check,'PASS');
  if(e.status==='PASS'){closed(e.checks,smokeChecks);assert.equal(e.failure,null);assert(typeof e.environment.browser==='string' && /^\d+\.\d+\.\d+\.\d+$/.test(e.environment.browser));}
  else {assert.equal(e.failure,'PACKAGE_SMOKE_FAILED');assert(e.environment.browser===null || typeof e.environment.browser==='string');}
  return e.status;
}
// readOptional returns null for absent evidence, and throws for unreadable/invalid files.
export function checkPlatformEvidence(manifest, readOptional) {
  return targets.map(target=>{
    const filename=`package-smoke-${target}.json`,bytes=readOptional(filename);
    if(bytes===null)return {layer:'package',target,status:'NOTRUN',evidence:null};
    const status=checkSmoke(JSON.parse(bytes),manifest.artifacts,manifest.release.source_commit,target);
    return {layer:'package',target,status,evidence:{filename,sha256:sha256(bytes)}};
  });
}
export function checkSums(text, manifest, read) {
  const names=[...manifest.artifacts.map(a=>a.filename),...Object.values(manifest.guides).map(g=>g.filename),'release-manifest.json'];
  const rows=text.trimEnd().split('\n').map(line=>{const m=/^([a-f0-9]{64})  ([a-z0-9.-]+)$/.exec(line);assert(m,'Invalid checksums');return {name:m[2],hash:m[1]};});assert.deepEqual(rows.map(r=>r.name).sort(),names.sort());
  for(const r of rows)assert.equal(sha256(read(r.name)),r.hash);return true;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args=process.argv.slice(2);assert(args.length===3 && ['--candidate','--manifest'].includes(args[0]) && /^[a-f0-9]{40}$/.test(args[2]),'release-validate --candidate|--manifest <directory> <expected-source-sha>');
    const dir=resolve(args[1]),read=name=>readFileSync(join(dir,name));
    if(args[0]==='--candidate'){const c=JSON.parse(read('candidate-index.json'));assert.equal(c.source_commit,args[2]);checkCandidate(c,read);const rows=read('CANDIDATE-SHA256SUMS').toString().trimEnd().split('\n');assert.equal(rows.length,6);assert.deepEqual(rows.map(r=>r.slice(66)).sort(),[...c.artifacts.map(a=>a.filename),'candidate-index.json'].sort());for(const r of rows)assert.equal(r,sha256(read(r.slice(66)))+'  '+r.slice(66));console.log(JSON.stringify({valid:true,kind:c.kind,complete_release:false,authority_verified:false}));}
    else {const m=JSON.parse(read('release-manifest.json'));const result=checkManifest(m,read,args[2]);checkSums(read('SHA256SUMS').toString(),m,read);const verification=checkPlatformEvidence(m,name=>{try{return read(name);}catch(e){if(e.code==='ENOENT')return null;throw e;}});console.log(JSON.stringify({...result,package_acceptance:verification.every(v=>v.status==='PASS'),verification}));}
  }catch {console.error('Candidate/manifest validation failed (no authority granted)');process.exitCode=1;}
}
