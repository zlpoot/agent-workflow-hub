import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCandidate, components, targets, sha256 } from './release-lib.mjs';
import { checkManifest, checkSums } from './release-validate.mjs';

// Never builds the other platform. Consume separately built, same-source native closures.
const args=process.argv.slice(2);assert(args.length===6 && args[0]==='--windows' && args[2]==='--macos' && args[4]==='--output','release-assemble --windows <candidate-dir> --macos <candidate-dir> --output <new-dir>');
const dirs=[resolve(args[1]),resolve(args[3])], candidates=dirs.map(dir=>JSON.parse(readFileSync(join(dir,'candidate-index.json'))));
for(const [i,c] of candidates.entries()){checkCandidate(c,name=>readFileSync(join(dirs[i],name)));assert.equal(c.target,targets[i]);}
const source=candidates[0].source_commit;assert.equal(candidates[1].source_commit,source,'Different source heads');
for(const a of candidates[1].artifacts)assert.deepEqual(a.build.provenance,candidates[0].artifacts[0].build.provenance,'Different lock/policy/contracts');
const output=resolve(args[5]);assert(!existsSync(output),'Never overwrite frozen candidates');mkdirSync(output,{recursive:true});
const artifacts=[];
for(const [i,c] of candidates.entries())for(const a of c.artifacts){if(i===1&&a.component==='awh-dashboard-ui')continue;copyFileSync(join(dirs[i],a.filename),join(output,a.filename));artifacts.push(a);}
const guides={},root=dirname(dirname(fileURLToPath(import.meta.url)));
for(const [key,name] of [['windows','install-windows.md'],['macos','install-macos.md']]){copyFileSync(join(root,'docs/release',name),join(output,name));guides[key]={filename:name,sha256:sha256(readFileSync(join(output,name)))};}
const verification=targets.map((target,i)=>{
  const name=`package-smoke-${target}.json`,path=join(dirs[i],name);if(!existsSync(path))return {layer:'package',target,status:'NOTRUN',evidence:null};
  const smoke=JSON.parse(readFileSync(path));
  // If the two separately built UI bytes differ, Mac must smoke the finally selected Windows UI
  // (using --ui-from); do not silently replace the UI digest in existing evidence.
  assert.equal(smoke.artifacts.find(a=>a.component==='awh-dashboard-ui')?.sha256,artifacts.find(a=>a.component==='awh-dashboard-ui').sha256,'Smoke must verify selected UI bytes');
  copyFileSync(path,join(output,name));return {layer:'package',target,status:'PASS',evidence:{filename:name,sha256:sha256(readFileSync(path))}};
});
const p=artifacts[0].build.provenance;
const manifest={schema_version:'1.0',kind:'awh_release_manifest',release:{id:'awh-'+source+'-rc.1',name:'AWH v0.1.0-rc.1',tag:'v0.1.0-rc.1',channel:'rc',state:'candidate_frozen',source_commit:source,source_clean:true,human_release_gate:'NOT_AUTHORIZED'},components,artifacts,
  compatibility:{protocol:'1.0',cp_database_schema:2,dashboard_api:'1.0.0',dashboard_contract_sha256:p['contracts/dashboard-v1.openapi.json'],handoff:'0.1',fixed_profile_policy_sha256:p['src/profiles.ts']},verification,
  unsupported_targets:[{target:'darwin-x64',status:'NOT_VERIFIED'},{target:'other',status:'NOT_VERIFIED'}],acceptance:{runtime_write:'NOT_ACCEPTED',full_delivery:'NOT_ACCEPTED'},historical_dispositions:{issue30:'PHASE_C_ACCEPTED_WITH_EXCEPTION',issue35:'WINDOWS_FIRST_USABLE_OBSERVE_ONLY',onboarding_api_1_0_0:'OFFLINE_FIXTURE_ONLY'},guides};
checkManifest(manifest,name=>readFileSync(join(output,name)),source);writeFileSync(join(output,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
const names=[...artifacts.map(a=>a.filename),...Object.values(guides).map(g=>g.filename),'release-manifest.json',...verification.filter(v=>v.evidence).map(v=>v.evidence.filename)];
const sums=names.map(name=>sha256(readFileSync(join(output,name)))+'  '+name).join('\n')+'\n';checkSums(sums,manifest,name=>readFileSync(join(output,name)));writeFileSync(join(output,'SHA256SUMS'),sums,{flag:'wx'});
console.log(JSON.stringify({source_commit:source,assets:9,package_verification:verification,publishable:false,authority_verified:false}));
